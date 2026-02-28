require('dotenv').config()
const express = require('express')
const axios = require('axios')
const querystring = require('querystring')

const app = express()
app.use(express.json())

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET
const REDIRECT_URI = 'http://127.0.0.1:3000/callback'

let access_token = null
let refresh_token = null

app.get('/login', (req, res) => {
  const scope = 'user-modify-playback-state user-read-playback-state user-read-currently-playing'
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

app.get('/callback', async (req, res) => {
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
  refresh_token = response.data.refresh_token

  res.send('Spotify connected! You can close this tab.')
})

app.post('/play', async (req, res) => {
  const { query } = req.body

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

  if (!uri) return res.status(404).send('Nothing found')

  await axios.put(
    'https://api.spotify.com/v1/me/player/play',
    uri.includes('playlist')
      ? { context_uri: uri }
      : { uris: [uri] },
    {
      headers: { Authorization: `Bearer ${access_token}` }
    }
  )

  res.send('Playing now!')
})

app.listen(3000, () => console.log('Server running on 3000'))