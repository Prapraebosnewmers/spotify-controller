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

console.log("REDIRECT_URI:", REDIRECT_URI)

let access_token = null
let refresh_token = process.env.SPOTIFY_REFRESH_TOKEN || null

// ---------------- TOKEN REFRESH ----------------

async function refreshAccessToken() {
  if (!refresh_token) {
    throw new Error("No refresh token available.")
  }

  const response = await axios.post(
    'https://accounts.spotify.com/api/token',
    querystring.stringify({
      grant_type: 'refresh_token',
      refresh_token: refresh_token
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
  console.log("✅ Access token refreshed")
}

async function spotifyRequest(method, endpoint, data = null) {
  try {
    return await axios({
      method,
      url: `https://api.spotify.com/v1${endpoint}`,
      data,
      headers: { Authorization: `Bearer ${access_token}` }
    })
  } catch (error) {
    if (error.response?.status === 401) {
      console.log("🔄 Token expired, refreshing...")
      await refreshAccessToken()
      return await axios({
        method,
        url: `https://api.spotify.com/v1${endpoint}`,
        data,
        headers: { Authorization: `Bearer ${access_token}` }
      })
    }
    throw error
  }
}

// ---------------- AUTH ----------------

app.get('/login', (req, res) => {
  const scope =
    'user-modify-playback-state user-read-playback-state user-read-currently-playing'

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
  try {
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
    res.send('Spotify connected!')
  } catch (err) {
    console.error(err.response?.data || err.message)
    res.status(500).send("Auth failed")
  }
})

// ---------------- SMART SEARCH ----------------

async function smartSearch(query) {
  const lower = query.toLowerCase()

  let searchQuery = query

  // Detect album
  if (lower.includes("from")) {
    const parts = query.split("from")
    const trackPart = parts[0].trim()
    const albumPart = parts[1].trim()

    searchQuery = `track:${trackPart} album:${albumPart}`
  }

  // Detect artist
  if (lower.includes("by")) {
    const parts = query.split("by")
    const trackPart = parts[0].trim()
    const artistPart = parts[1].trim()

    searchQuery = `track:${trackPart} artist:${artistPart}`
  }

  const result = await spotifyRequest(
    "get",
    `/search?q=${encodeURIComponent(searchQuery)}&type=track&limit=5`
  )

  if (result.data.tracks.items.length > 0) {
    return result.data.tracks.items[0].uri
  }

  // fallback to playlist search
  const playlistResult = await spotifyRequest(
    "get",
    `/search?q=${encodeURIComponent(query)}&type=playlist&limit=1`
  )

  if (playlistResult.data.playlists.items.length > 0) {
    return playlistResult.data.playlists.items[0].uri
  }

  return null
}

// ---------------- PLAY ----------------

app.post('/play', async (req, res) => {
  try {
    const { query } = req.body

    if (!access_token && refresh_token) {
      await refreshAccessToken()
    }

    const uri = await smartSearch(query)

    if (!uri) return res.status(404).send("Nothing found")

    if (uri.includes("playlist")) {
      await spotifyRequest("put", "/me/player/play", {
        context_uri: uri
      })
    } else {
      await spotifyRequest("put", "/me/player/play", {
        uris: [uri]
      })
    }

    res.send("Playing")
  } catch (err) {
    console.error(err.response?.data || err.message)
    res.status(500).send("Playback failed")
  }
})

// ---------------- CONTROLS ----------------

app.post('/pause', async (req, res) => {
  try {
    await spotifyRequest("put", "/me/player/pause")
    res.send("Paused")
  } catch {
    res.status(500).send("Pause failed")
  }
})

app.post('/skip', async (req, res) => {
  try {
    await spotifyRequest("post", "/me/player/next")
    res.send("Skipped")
  } catch {
    res.status(500).send("Skip failed")
  }
})

app.post('/volume', async (req, res) => {
  try {
    const { level } = req.body
    if (level < 0 || level > 100) {
      return res.status(400).send("Volume must be 0-100")
    }

    await spotifyRequest("put", `/me/player/volume?volume_percent=${level}`)
    res.send(`Volume set to ${level}%`)
  } catch {
    res.status(500).send("Volume failed")
  }
})

app.listen(3000, () => console.log("🚀 Server running on 3000"))