require('dotenv').config()
const express = require('express')
const axios = require('axios')
const querystring = require('querystring')

const app = express()
app.use(express.json())

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET

const REDIRECT_URI =
  process.env.RENDER_EXTERNAL_URL
    ? `${process.env.RENDER_EXTERNAL_URL}/callback`
    : 'http://127.0.0.1:3000/callback'

let access_token = null
let refresh_token = process.env.SPOTIFY_REFRESH_TOKEN || null

// ---------------- TOKEN REFRESH ----------------

async function refreshAccessToken() {
  if (!refresh_token) throw new Error("No refresh token")

  const response = await axios.post(
    'https://accounts.spotify.com/api/token',
    querystring.stringify({
      grant_type: 'refresh_token',
      refresh_token
    }),
    {
      headers: {
        Authorization:
          'Basic ' +
          Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    }
  )

  access_token = response.data.access_token
  console.log("✅ Token refreshed")
}

async function spotifyRequest(method, endpoint, data = null) {
  try {
    return await axios({
      method,
      url: `https://api.spotify.com/v1${endpoint}`,
      data,
      headers: { Authorization: `Bearer ${access_token}` }
    })
  } catch (err) {
    if (err.response?.status === 401) {
      await refreshAccessToken()
      return await axios({
        method,
        url: `https://api.spotify.com/v1${endpoint}`,
        data,
        headers: { Authorization: `Bearer ${access_token}` }
      })
    }
    console.error("SPOTIFY ERROR:", err.response?.data || err.message)
    throw err
  }
}

// ---------------- DEVICE HANDLING ----------------

async function ensureActiveDevice() {
  const devices = await spotifyRequest("get", "/me/player/devices")

  if (!devices.data.devices.length) {
    throw new Error("No Spotify devices found. Open Spotify first.")
  }

  const active = devices.data.devices.find(d => d.is_active)
  if (active) return active.id

  const firstDevice = devices.data.devices[0]

  await spotifyRequest("put", "/me/player", {
    device_ids: [firstDevice.id],
    play: false
  })

  return firstDevice.id
}

// ---------------- AUTH ----------------

app.get('/login', (req, res) => {
  const scope =
    'user-modify-playback-state user-read-playback-state user-read-currently-playing playlist-read-private playlist-read-collaborative'

  res.redirect(
    'https://accounts.spotify.com/authorize?' +
      querystring.stringify({
        response_type: 'code',
        client_id: CLIENT_ID,
        scope,
        redirect_uri: REDIRECT_URI
      })
  )
})

app.get('/callback', async (req, res) => {
  const code = req.query.code

  const response = await axios.post(
    'https://accounts.spotify.com/api/token',
    querystring.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI
    }),
    {
      headers: {
        Authorization:
          'Basic ' +
          Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    }
  )

  access_token = response.data.access_token
  refresh_token = response.data.refresh_token || refresh_token

  console.log("🎉 REFRESH TOKEN:", refresh_token)
  res.send("Spotify connected")
})

// ---------------- SEARCH ----------------

async function searchUserPlaylistExact(name) {
  const result = await spotifyRequest("get", "/me/playlists?limit=50")

  const match = result.data.items.find(
    p => p.name.toLowerCase() === name.toLowerCase()
  )

  return match ? match.uri : null
}

async function searchPublicPlaylist(query) {
  const result = await spotifyRequest(
    "get",
    `/search?q=${encodeURIComponent(query)}&type=playlist&limit=5`
  )

  return result.data.playlists.items.length
    ? result.data.playlists.items[0].uri
    : null
}

async function searchTrack(query) {
  const result = await spotifyRequest(
    "get",
    `/search?q=${encodeURIComponent(query)}&type=track&limit=5`
  )

  return result.data.tracks.items.length
    ? result.data.tracks.items[0].uri
    : null
}

// ---------------- PLAY ----------------

app.post('/play', async (req, res) => {
  try {
    const { query } = req.body

    if (!access_token && refresh_token) {
      await refreshAccessToken()
    }

    const deviceId = await ensureActiveDevice()

    // Resume if no query
    if (!query || query.trim() === "") {
      await spotifyRequest("put", `/me/player/play?device_id=${deviceId}`)
      return res.send("Resumed")
    }

    const lower = query.toLowerCase()
    const wantsShuffle = !lower.includes("no shuffle")

    // 1️⃣ Your playlists first
    const userPlaylist = await searchUserPlaylistExact(query)
    if (userPlaylist) {
      await spotifyRequest(
        "put",
        `/me/player/shuffle?state=${wantsShuffle}&device_id=${deviceId}`
      )

      await spotifyRequest(
        "put",
        `/me/player/play?device_id=${deviceId}`,
        { context_uri: userPlaylist }
      )

      return res.send("Your playlist playing")
    }

    // 2️⃣ Public playlists
    const publicPlaylist = await searchPublicPlaylist(query)
    if (publicPlaylist) {
      await spotifyRequest(
        "put",
        `/me/player/shuffle?state=${wantsShuffle}&device_id=${deviceId}`
      )

      await spotifyRequest(
        "put",
        `/me/player/play?device_id=${deviceId}`,
        { context_uri: publicPlaylist }
      )

      return res.send("Playlist playing")
    }

    // 3️⃣ Track fallback (device primed first)
    const trackUri = await searchTrack(query)
    if (trackUri) {
      await spotifyRequest(
        "put",
        `/me/player/shuffle?state=false&device_id=${deviceId}`
      )

      // Prime playback context
      await spotifyRequest(
        "put",
        `/me/player/play?device_id=${deviceId}`
      )

      await spotifyRequest(
        "put",
        `/me/player/play?device_id=${deviceId}`,
        { uris: [trackUri] }
      )

      return res.send("Track playing")
    }

    res.status(404).send("Nothing found")
  } catch (err) {
    console.error("PLAY ERROR:", err.response?.data || err.message)
    res.status(500).send("Playback failed")
  }
})

// ---------------- CONTROLS ----------------

app.post('/resume', async (req, res) => {
  try {
    const deviceId = await ensureActiveDevice()
    await spotifyRequest("put", `/me/player/play?device_id=${deviceId}`)
    res.send("Resumed")
  } catch {
    res.status(500).send("Resume failed")
  }
})

app.post('/pause', async (req, res) => {
  try {
    const deviceId = await ensureActiveDevice()
    await spotifyRequest("put", `/me/player/pause?device_id=${deviceId}`)
    res.send("Paused")
  } catch {
    res.status(500).send("Pause failed")
  }
})

app.post('/skip', async (req, res) => {
  try {
    const deviceId = await ensureActiveDevice()
    await spotifyRequest("post", `/me/player/next?device_id=${deviceId}`)
    res.send("Skipped")
  } catch {
    res.status(500).send("Skip failed")
  }
})

app.post('/volume', async (req, res) => {
  try {
    const { level } = req.body
    if (level < 0 || level > 100)
      return res.status(400).send("Volume must be 0-100")

    const deviceId = await ensureActiveDevice()

    await spotifyRequest(
      "put",
      `/me/player/volume?volume_percent=${level}&device_id=${deviceId}`
    )

    res.send(`Volume set to ${level}%`)
  } catch {
    res.status(500).send("Volume failed")
  }
})

app.listen(3000, () => console.log("🚀 Server running on 3000"))