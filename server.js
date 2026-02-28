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

// 🔄 Refresh Access Token
async function refreshAccessToken() {
  if (!refresh_token) {
    throw new Error("No refresh token available. Please re-authenticate.")
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

// 🔐 Login Route
app.get('/login', (req, res) => {
  const scope =
    'user-modify-playback-state user-read-playback-state user-read-currently-playing'

  res.redirect(
    'https://accounts.spotify.com/authorize?' +
      querystring.stringify({
        response_type: 'code',
        client_id: CLIENT_ID,
        scope: scope,
        redirect_uri: REDIRECT_URI
      })
  )
})

// 🔑 Callback Route
app.get('/callback', async (req, res) => {
  try {
    const code = req.query.code

    const response = await axios.post(
      'https://accounts.spotify.com/api/token',
      querystring.stringify({
        grant_type: 'authorization_code',
        code: code,
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

    console.log("🎉 NEW REFRESH TOKEN:", refresh_token)

    res.send(
      'Spotify connected! You can close this tab. (Copy refresh token from logs if first time)'
    )
  } catch (error) {
    console.error("Callback error:", error.response?.data || error.message)
    res.status(500).send("Authentication failed")
  }
})

// 🎵 Play Route
app.post('/play', async (req, res) => {
  try {
    const { query } = req.body

    if (!access_token && refresh_token) {
      await refreshAccessToken()
    }

    const search = await axios.get(
      'https://api.spotify.com/v1/search',
      {
        headers: { Authorization: `Bearer ${access_token}` },
        params: { q: query, type: 'track,playlist', limit: 1 }
      }
    )

    let uri = null

    if (search.data.tracks.items.length > 0) {
      uri = search.data.tracks.items[0].uri
    } else if (search.data.playlists.items.length > 0) {
      uri = search.data.playlists.items[0].uri
    }

    if (!uri) {
      return res.status(404).send('Nothing found')
    }

    try {
      await axios.put(
        'https://api.spotify.com/v1/me/player/play',
        uri.includes('playlist')
          ? { context_uri: uri }
          : { uris: [uri] },
        {
          headers: { Authorization: `Bearer ${access_token}` }
        }
      )
    } catch (error) {
      if (error.response && error.response.status === 401) {
        console.log("🔄 Token expired. Refreshing...")
        await refreshAccessToken()

        await axios.put(
          'https://api.spotify.com/v1/me/player/play',
          uri.includes('playlist')
            ? { context_uri: uri }
            : { uris: [uri] },
          {
            headers: { Authorization: `Bearer ${access_token}` }
          }
        )
      } else {
        throw error
      }
    }

    res.send('Playing now!')
  } catch (error) {
    console.error("Play error:", error.response?.data || error.message)
    res.status(500).send("Playback failed")
  }
})

app.listen(3000, () => console.log('🚀 Server running on 3000'))