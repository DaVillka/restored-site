const path = require('node:path')
const express = require('express')

const port = Number(process.env.PORT || 3000)
const app = express()

app.use((req, _res, next) => {
    console.log(`[HTTP] ${req.method} ${req.originalUrl}`)
    next()
})

const SITE_DIR = path.join(__dirname, '..')
app.use(express.static(SITE_DIR))
app.get('*splat', (_req, res) => {
    res.sendFile(path.join(SITE_DIR, 'index.html'))
})

app.listen(port, () => {
    console.log(`Site: http://localhost:${port}`)
    console.log(`(offline mode with mock Telegram data)`)
})
