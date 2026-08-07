const express    = require('express');
const cors       = require('cors');
const mysql      = require('mysql2');
const bcrypt     = require('bcrypt');
const path       = require('path');
const Stripe     = require('stripe');
require('dotenv').config();

const app = express();

const stripeSecretKey = (process.env.STRIPE_SECRET_KEY || '').trim();
const stripeKeyOk = stripeSecretKey.startsWith('sk_test_') || stripeSecretKey.startsWith('sk_live_');
const stripe = stripeKeyOk ? Stripe(stripeSecretKey) : null;
if (!stripeKeyOk) {
    if (stripeSecretKey.startsWith('pk_')) {
        console.warn('\n⚠️  STRIPE_SECRET_KEY is set to a Publishable key (pk_). Use the Secret key (sk_test_ or sk_live_) from Stripe Dashboard → API keys.\n');
    } else if (stripeSecretKey) {
        console.warn('\n⚠️  STRIPE_SECRET_KEY must be your full Secret key (starts with sk_test_ or sk_live_). Replace the placeholder in .env.\n');
    } else {
        console.warn('\n⚠️  STRIPE_SECRET_KEY is missing. In .env set: STRIPE_SECRET_KEY=sk_test_...\n   (Stripe Dashboard → Developers → API keys → Secret key)\n');
    }
}

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());
app.use('/assets', express.static(path.join(__dirname, 'assets')));

// ============================================================
//  DATABASE
// ============================================================

const db = mysql.createPool({
    host     : process.env.DB_HOST,
    user     : process.env.DB_USER,
    password : process.env.DB_PASSWORD,
    database : process.env.DB_NAME,
    port     : process.env.DB_PORT || 3306,
    ssl      : process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined
});

db.getConnection((err, connection) => {
    if (err) { console.log('❌ Database connection failed:', err.message); return; }
    console.log('✅ Connected to MySQL — libas_verse');
    connection.release();
});

// ============================================================
//  NODEMAILER — shared transporter
// ============================================================
const BREVO_API_KEY = process.env.BREVO_API_KEY || 'Enter your API';
const MAIL_USER     = process.env.MAIL_USER || 'Enter your Email';
const MAIL_NAME     = 'Enter you Mail';

// Reusable HTML email wrapper with logo
function emailTemplate(title, bodyHtml) {
    return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f5f5f5;padding:20px;border-radius:12px;">
      <div style="background:#1A3A6B;border-radius:10px 10px 0 0;padding:24px;text-align:center;">
        <h1 style="color:#ffffff;margin:0;font-size:24px;letter-spacing:1px;">Libas<span style="color:#29B6F6;">Verse</span></h1>
        <p style="color:#29B6F6;margin:4px 0 0;font-size:12px;letter-spacing:2px;">PAKISTAN'S FASHION MARKETPLACE</p>
      </div>
      <div style="background:#ffffff;padding:32px;border-radius:0 0 10px 10px;">
        <h2 style="color:#1A3A6B;margin-top:0;">${title}</h2>
        ${bodyHtml}
        <hr style="border:none;border-top:1px solid #f0f0f0;margin:24px 0;">
        <p style="color:#aaaaaa;font-size:11px;text-align:center;margin:0;">
          © ${new Date().getFullYear()} LibasVerse. All rights reserved.<br>
          This is an automated email, please do not reply directly.
        </p>
      </div>
    </div>`;
}

// Send email via Brevo HTTP API — works on Railway, sends to any email
async function sendEmail({ to, subject, html }) {
    try {
        const res = await fetch('https://api.brevo.com/v3/smtp/email', {
            method : 'POST',
            headers: {
                'accept'      : 'application/json',
                'api-key'     : BREVO_API_KEY,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                sender     : { name: MAIL_NAME, email: MAIL_USER },
                to         : [{ email: to }],
                subject    : subject,
                htmlContent: html,
            }),
        });
        if (!res.ok) {
            const err = await res.text();
            console.error(`📧 Email FAILED to ${to} — ${err}`);
        } else {
            console.log(`📧 Email sent to ${to}`);
        }
    } catch (err) {
        console.error(`📧 Email FAILED to ${to} — ${err.message}`);
    }
}

app.get('/api/v1/test-email', async (req, res) => {
    try {
        const r = await fetch('https://api.brevo.com/v3/smtp/email', {
            method : 'POST',
            headers: {
                'accept'      : 'application/json',
                'api-key'     : BREVO_API_KEY,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                sender     : { name: MAIL_NAME, email: MAIL_USER },
                to         : [{ email: MAIL_USER }],
                subject    : 'LibasVerse — Email Test',
                htmlContent: '<p>If you see this, Brevo is working correctly!</p>',
            }),
        });
        if (!r.ok) return res.status(500).json({ error: await r.text() });
        res.json({ message: 'Test email sent to ' + MAIL_USER });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

function normalizeCartSize(size) {
    if (size == null) return '';
    return String(size).trim();
}

const NON_CLOTHING_CATEGORY_HINTS = ['bag', 'bags', 'watch', 'watches', 'jewelry', 'jewellery', 'perfume', 'fragrance',
    'belt', 'wallet', 'sunglass', 'glasses', 'scrunchie', 'pin', 'brooch', 'phone case', 'case'];

function isClothingCategory(category) {
    if (!category || typeof category !== 'string') return false;
    const c = category.trim().toLowerCase();
    if (NON_CLOTHING_CATEGORY_HINTS.some(h => c.includes(h))) return false;
    const clothingHints = [
        'men', 'women', 'woman', 'kid', 'kids', 'boy', 'boys', 'girl', 'girls', 'unisex',
        'shalwar', 'kameez', 'kurta', 'abaya', 'dupatta', 'lawn', 'pret', 'unstitch', 'stitch',
        'formal', 'casual', 'bridal', 'ethnic', 'traditional', 'dress', 'shirt', 'shirts', 'trouser',
        'pant', 'pants', 'suit', 'libas', 'kurti', 'saree', 'sari', 'waistcoat', 'shawl', 'hoodie',
        'jacket', 'coat', 'tee', 'top', 'bottom', 'gown', 'maxi', 'frock', 'eastern', 'western'
    ];
    return clothingHints.some(h => c.includes(h));
}

// ============================================================
//  SECTOR 1 — AUTHENTICATION
// ============================================================

app.post('/api/v1/auth/register', async (req, res) => {
    const { name, email, password, phone } = req.body;
    if (!name || !email || !password) return res.status(400).json({ message: 'Name, email and password are required' });
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        db.query('SELECT COUNT(*) AS total FROM users', async (err, results) => {
            if (err) return res.status(500).json({ error: err.message });
            const user_uid = 'USR-' + String(results[0].total + 1).padStart(5, '0');
            db.query('INSERT INTO users (user_uid, name, email, password, phone) VALUES (?, ?, ?, ?, ?)',
                [user_uid, name, email, hashedPassword, phone || null], (err, result) => {
                if (err) {
                    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Email already registered' });
                    return res.status(500).json({ error: err.message });
                }
                res.status(201).json({ message: 'Registration successful', user_id: result.insertId, user_uid });
            });
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/v1/auth/login', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Email and password are required' });
    db.query('SELECT * FROM users WHERE email = ?', [email], async (err, userResults) => {
        if (err) return res.status(500).json({ error: err.message });
        if (userResults.length > 0) {
            const user = userResults[0];
            const match = await bcrypt.compare(password, user.password);
            if (!match) return res.status(401).json({ message: 'Invalid email or password' });
            delete user.password;
            return res.json({ message: 'Login successful', role: 'user', data: user });
        }
        db.query('SELECT * FROM brands WHERE email = ? AND password = ?', [email, password], (err, brandResults) => {
            if (err) return res.status(500).json({ error: err.message });
            if (brandResults.length === 0) return res.status(401).json({ message: 'Invalid email or password' });
            const brand = brandResults[0];
            delete brand.password;
            return res.json({ message: 'Login successful', role: 'brand', data: brand });
        });
    });
});

app.post('/api/v1/auth/google-login', (req, res) => {
    const { name, email, photo_url } = req.body;
    if (!email) return res.status(400).json({ message: 'Email required' });
    db.query('SELECT * FROM users WHERE email = ?', [email], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        if (results.length > 0) {
            const user = results[0];
            delete user.password;
            return res.json({ message: 'Login successful', data: user });
        }
        db.query('SELECT COUNT(*) AS total FROM users', (err2, countRes) => {
            if (err2) return res.status(500).json({ error: err2.message });
            const user_uid = 'USR-' + String(countRes[0].total + 1).padStart(5, '0');
            const randomPass = Math.random().toString(36).slice(2);
            db.query('INSERT INTO users (user_uid, name, email, password, photo_url) VALUES (?, ?, ?, ?, ?)',
                [user_uid, name || 'User', email, randomPass, photo_url || null], (err3, result) => {
                if (err3) return res.status(500).json({ error: err3.message });
                db.query('SELECT * FROM users WHERE id = ?', [result.insertId], (err4, newUser) => {
                    if (err4) return res.status(500).json({ error: err4.message });
                    const user = newUser[0];
                    delete user.password;
                    res.status(201).json({ message: 'Registered successfully', data: user });
                });
            });
        });
    });
});

// ── Send welcome-back email on login ─────────────────────────
app.post('/api/v1/auth/email-login', (req, res) => {
    const { name, email } = req.body;
    if (!email) return res.status(400).json({ message: 'Email required' });
    sendEmail({
        to     : email,
        subject: 'Welcome Back to LibasVerse! 👋',
        html   : emailTemplate('Welcome Back!', `
            <p style="color:#555;font-size:15px;">Hey <strong>${name || 'there'}</strong>,</p>
            <p style="color:#555;font-size:15px;">Great to see you again! You've successfully logged in to your LibasVerse account.</p>
            <p style="color:#555;font-size:15px;">Explore the latest collections from your favourite brands — Khaadi, Sapphire, Levis, Outfitters and more.</p>
            <p style="color:#aaa;font-size:12px;">If this wasn't you, please contact us at <a href="mailto:${MAIL_USER}" style="color:#29B6F6;">${MAIL_USER}</a></p>
        `),
    });
    res.json({ message: 'Login email sent' });
});

// ── Send welcome email on signup ──────────────────────────────
app.post('/api/v1/auth/email-signup', (req, res) => {
    const { name, email } = req.body;
    if (!email) return res.status(400).json({ message: 'Email required' });
    sendEmail({
        to     : email,
        subject: 'Welcome to LibasVerse! 🎉',
        html   : emailTemplate('Welcome to LibasVerse!', `
            <p style="color:#555;font-size:15px;">Hey <strong>${name || 'there'}</strong>,</p>
            <p style="color:#555;font-size:15px;">Your account has been created successfully. You're now part of Pakistan's premier fashion marketplace!</p>
            <p style="color:#555;font-size:15px;">Discover collections from top Pakistani brands, add items to your wishlist, and enjoy a seamless shopping experience.</p>
            <div style="background:#f0f8ff;border-left:4px solid #29B6F6;padding:14px;border-radius:6px;margin:20px 0;">
              <p style="margin:0;color:#1A3A6B;font-size:13px;font-weight:bold;">🛍️ What you can do on LibasVerse:</p>
              <ul style="color:#555;font-size:13px;margin:8px 0 0;padding-left:18px;">
                <li>Browse Eastern & Western wear from top brands</li>
                <li>Save favourites to your Wishlist</li>
                <li>Track your orders in real time</li>
                <li>Pay securely via Stripe or Cash on Delivery</li>
              </ul>
            </div>
        `),
    });
    res.json({ message: 'Signup email sent' });
});

// ── Help & Support — user message to support inbox ────────────
app.post('/api/v1/support', (req, res) => {
    const { name, email, subject, message } = req.body;
    if (!email || !message) return res.status(400).json({ message: 'Email and message required' });
    // Save to DB
    db.query('INSERT INTO support_tickets (name, email, subject, message) VALUES (?, ?, ?, ?)',
        [name || 'Unknown', email, subject || 'General Query', message], (err) => {
        if (err) console.warn('Support ticket DB save failed:', err.message);
    });
    // Send to support inbox
    sendEmail({
        to     : MAIL_USER,
        subject: `[LibasVerse Support] ${subject || 'New Message'} — from ${name || email}`,
        html   : emailTemplate('New Support Request', `
            <p style="color:#555;"><strong>From:</strong> ${name || 'N/A'}</p>
            <p style="color:#555;"><strong>Email:</strong> <a href="mailto:${email}" style="color:#29B6F6;">${email}</a></p>
            <p style="color:#555;"><strong>Subject:</strong> ${subject || 'General Query'}</p>
            <div style="background:#f5f5f5;padding:16px;border-radius:8px;margin-top:12px;">
              <p style="color:#333;font-size:14px;margin:0;white-space:pre-wrap;">${message}</p>
            </div>
        `),
    });
    // Send confirmation to user
    sendEmail({
        to     : email,
        subject: 'We received your message — LibasVerse Support',
        html   : emailTemplate('We got your message! ✅', `
            <p style="color:#555;font-size:15px;">Hi <strong>${name || 'there'}</strong>,</p>
            <p style="color:#555;font-size:15px;">Thank you for reaching out! We've received your message and our support team will get back to you within <strong>24 hours</strong>.</p>
            <div style="background:#f0f8ff;border-left:4px solid #29B6F6;padding:14px;border-radius:6px;margin:20px 0;">
              <p style="margin:0;color:#555;font-size:13px;"><strong>Your message:</strong></p>
              <p style="margin:8px 0 0;color:#555;font-size:13px;white-space:pre-wrap;">${message}</p>
            </div>
            <p style="color:#aaa;font-size:12px;">You can also reach us directly at <a href="mailto:${MAIL_USER}" style="color:#29B6F6;">${MAIL_USER}</a></p>
        `),
    });
    res.json({ message: 'Support request sent' });
});

// ── Admin: get all support tickets ───────────────────────────
app.get('/api/v1/admin/support-tickets', (req, res) => {
    db.query('SELECT * FROM support_tickets ORDER BY created_at DESC', (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// ── Admin: resolve (delete) a support ticket ─────────────────
app.delete('/api/v1/admin/support-tickets/:id', (req, res) => {
    db.query('DELETE FROM support_tickets WHERE id = ?', [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Ticket resolved' });
    });
});

app.post('/api/v1/auth/forgot-password', async (req, res) => {
    const { email } = req.body;
    db.query('SELECT * FROM users WHERE email = ?', [email], async (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        if (results.length === 0) return res.status(404).json({ message: 'Email not found' });
        const otp = Math.floor(1000 + Math.random() * 9000).toString();
        const expires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
        db.query('DELETE FROM password_resets WHERE email = ?', [email], () => {
            db.query('INSERT INTO password_resets (email, otp, expires_at) VALUES (?, ?, ?)',
                [email, otp, expires], async (err2) => {
                if (err2) return res.status(500).json({ error: err2.message });
                await sendEmail({
                    to     : email,
                    subject: 'LibasVerse — Password Reset OTP',
                    html   : emailTemplate('Password Reset OTP', `
                        <p style="color:#555;font-size:15px;">Hi <strong>${results[0].name}</strong>,</p>
                        <p style="color:#555;font-size:15px;">You requested a password reset. Use the OTP below to reset your password:</p>
                        <div style="text-align:center;margin:28px 0;">
                          <div style="display:inline-block;background:#1A3A6B;color:#ffffff;font-size:36px;font-weight:bold;letter-spacing:12px;padding:16px 32px;border-radius:12px;">${otp}</div>
                        </div>
                        <p style="color:#888;font-size:13px;text-align:center;">This OTP is valid for <strong>10 minutes</strong>.</p>
                        <p style="color:#aaa;font-size:12px;">If you didn't request this, you can safely ignore this email.</p>
                    `),
                });
                res.json({ message: 'OTP sent' });
            });
        });
    });
});

app.post('/api/v1/auth/verify-otp', (req, res) => {
    const { email, otp } = req.body;
    db.query('SELECT * FROM password_resets WHERE email = ? AND otp = ?', [email, otp], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!results.length) return res.status(400).json({ message: 'Invalid OTP' });
        if (new Date(results[0].expires_at) < new Date()) {
            db.query('DELETE FROM password_resets WHERE email = ?', [email], () => {});
            return res.status(400).json({ message: 'OTP has expired. Please request a new one.' });
        }
        res.json({ message: 'OTP verified' });
    });
});

app.post('/api/v1/auth/reset-password', async (req, res) => {
    const { email, otp, new_password } = req.body;
    db.query('SELECT * FROM password_resets WHERE email = ? AND otp = ?', [email, otp], async (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!results.length) return res.status(400).json({ message: 'Invalid or expired OTP' });
        if (new Date(results[0].expires_at) < new Date()) return res.status(400).json({ message: 'OTP expired' });
        const hashed = await bcrypt.hash(new_password, 10);
        db.query('UPDATE users SET password = ? WHERE email = ?', [hashed, email], (err2) => {
            if (err2) return res.status(500).json({ error: err2.message });
            db.query('DELETE FROM password_resets WHERE email = ?', [email], () => {});
            res.json({ message: 'Password reset successfully' });
        });
    });
});

// ============================================================
//  SECTOR 2 — USER PROFILE
// ============================================================

app.get('/api/v1/profile/:userId', (req, res) => {
    db.query('SELECT id, name, email, phone, address, created_at FROM users WHERE id = ?', [req.params.userId], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        if (results.length === 0) return res.status(404).json({ message: 'User not found' });
        res.json(results[0]);
    });
});

app.put('/api/v1/profile/update', (req, res) => {
    const { user_id, name, email, address, photo_url, gender } = req.body;
    db.query('UPDATE users SET name = ?, email = ?, address = ?, photo_url = ?, gender = ? WHERE id = ?',
        [name, email, address || null, photo_url || null, gender || null, user_id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Profile updated successfully' });
    });
});

app.get('/api/v1/addresses/:userId', (req, res) => {
    db.query('SELECT address FROM users WHERE id = ?', [req.params.userId], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results[0] || {});
    });
});

// ============================================================
//  SECTOR 3 — CATALOG
// ============================================================

app.get('/api/v1/products', (req, res) => {
    const { category, search } = req.query;
    let sql = `SELECT p.*,
        b.name AS brand_name,
        b.sale_percent,
        b.sale_until,
        CASE
          WHEN p.tag = 'Sale' AND p.sale_price IS NOT NULL THEN p.sale_price
          WHEN b.sale_percent > 0 AND (b.sale_until IS NULL OR b.sale_until >= CURDATE())
               THEN ROUND(p.price - (p.price * b.sale_percent / 100))
          ELSE NULL
        END AS effective_sale_price
        FROM products p JOIN brands b ON p.brand_id = b.id`;
    let params = [];
    if (category && search) { sql += ' WHERE p.category = ? AND p.name LIKE ?'; params = [category, `%${search}%`]; }
    else if (category)      { sql += ' WHERE p.category = ?'; params = [category]; }
    else if (search)        { sql += ' WHERE p.name LIKE ? OR b.name LIKE ?'; params = [`%${search}%`, `%${search}%`]; }
    db.query(sql, params, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        // Normalize: effective_sale_price → sale_price so Flutter needs no changes
        const mapped = results.map(p => ({
            ...p,
            sale_price: p.effective_sale_price ?? p.sale_price ?? null,
        }));
        res.json(mapped);
    });
});

app.get('/api/v1/products/:productId', (req, res) => {
    db.query('SELECT p.*, b.name AS brand_name FROM products p JOIN brands b ON p.brand_id = b.id WHERE p.product_id = ?',
        [req.params.productId], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        if (results.length === 0) return res.status(404).json({ message: 'Product not found' });
        res.json(results[0]);
    });
});

app.post('/api/v1/products/upload', (req, res) => {
    const { product_id, brand_id, name, price, category, image_url, description, sizes, stock, tag, sale_price } = req.body;
    if (!brand_id || !name || !price || !category || !image_url) return res.status(400).json({ message: 'All fields are required' });
    const pid      = product_id || (brand_id + '-' + Date.now());
    const stockVal = parseInt(stock) >= 0 ? parseInt(stock) : 50;
    const tagVal   = ['New', 'Sale'].includes(tag) ? tag : '';
    const salePriceVal = (tagVal === 'Sale' && sale_price && parseInt(sale_price) > 0) ? parseInt(sale_price) : null;
    db.query(
        'INSERT INTO products (product_id, brand_id, name, price, category, image_url, description, sizes, stock, tag, sale_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [pid, brand_id, name, price, category, image_url, description || '', sizes || '', stockVal, tagVal, salePriceVal],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.status(201).json({ message: 'Product uploaded successfully', product_id: pid });
        }
    );
});

app.put('/api/v1/products/:productId/restock', (req, res) => {
    const { stock } = req.body;
    const stockVal = parseInt(stock);
    if (isNaN(stockVal) || stockVal < 0) return res.status(400).json({ message: 'Valid stock quantity required' });
    db.query('UPDATE products SET stock = ? WHERE product_id = ?', [stockVal, req.params.productId], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Stock updated', stock: stockVal });
    });
});

// Brand: edit product details (name, price, tag, description, sizes, category)
app.put('/api/v1/products/:productId/edit', (req, res) => {
    const { name, price, tag, sale_price, description, sizes, category } = req.body;
    const tagVal       = ['New', 'Sale'].includes(tag) ? tag : '';
    const salePriceVal = (tagVal === 'Sale' && sale_price && parseInt(sale_price) > 0) ? parseInt(sale_price) : null;
    db.query(
        'UPDATE products SET name = ?, price = ?, tag = ?, sale_price = ?, description = ?, sizes = ?, category = ? WHERE product_id = ?',
        [name, price, tagVal, salePriceVal, description || '', sizes || '', category, req.params.productId],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: 'Product updated successfully' });
        }
    );
});

app.delete('/api/v1/products/:productId', (req, res) => {
    const pid = req.params.productId;
    db.query('DELETE FROM cart WHERE product_id = ?', [pid], () => {
        db.query('DELETE FROM wishlist WHERE product_id = ?', [pid], () => {
            db.query('DELETE FROM reviews WHERE product_id = ?', [pid], () => {
                db.query('DELETE FROM products WHERE product_id = ?', [pid], (err) => {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json({ message: 'Product deleted successfully' });
                });
            });
        });
    });
});

// ============================================================
//  SECTOR 4 — CART
// ============================================================

app.post('/api/v1/cart/add', (req, res) => {
    const { user_id, product_id, quantity, size } = req.body;
    if (!user_id || !product_id) return res.status(400).json({ message: 'user_id and product_id required' });
    db.query('SELECT category FROM products WHERE product_id = ?', [product_id], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        if (results.length === 0) return res.status(404).json({ message: 'Product not found' });
        const sizeNorm = normalizeCartSize(size);
        if (isClothingCategory(results[0].category) && !sizeNorm) {
            return res.status(400).json({ message: 'Size is required for this product category' });
        }
        const sql = `INSERT INTO cart (user_id, product_id, size, quantity)
                     VALUES (?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE quantity = quantity + ?`;
        db.query(sql, [user_id, product_id, sizeNorm, quantity || 1, quantity || 1], (err2) => {
            if (err2) return res.status(500).json({ error: err2.message });
            res.json({ message: 'Added to cart' });
        });
    });
});

app.get('/api/v1/cart/:userId', (req, res) => {
    const sql = `
        SELECT c.id, c.quantity, c.size, p.product_id, p.name, p.price, p.image_url, b.name AS brand_name
        FROM cart c
        JOIN products p ON c.product_id = p.product_id
        JOIN brands b ON p.brand_id = b.id
        WHERE c.user_id = ?
    `;
    db.query(sql, [req.params.userId], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.delete('/api/v1/cart/remove', (req, res) => {
    const { user_id, product_id, size } = req.body;
    const sizeNorm = normalizeCartSize(size);
    db.query('DELETE FROM cart WHERE user_id = ? AND product_id = ? AND size = ?', [user_id, product_id, sizeNorm], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Removed from cart' });
    });
});

app.put('/api/v1/cart/update', (req, res) => {
    const { user_id, product_id, quantity, size } = req.body;
    const sizeNorm = normalizeCartSize(size);
    if (quantity <= 0) {
        db.query('DELETE FROM cart WHERE user_id = ? AND product_id = ? AND size = ?', [user_id, product_id, sizeNorm], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: 'Removed from cart' });
        });
    } else {
        db.query('UPDATE cart SET quantity = ? WHERE user_id = ? AND product_id = ? AND size = ?',
            [quantity, user_id, product_id, sizeNorm], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: 'Quantity updated' });
        });
    }
});

app.delete('/api/v1/cart/clear', (req, res) => {
    const { user_id } = req.body;
    db.query('DELETE FROM cart WHERE user_id = ?', [user_id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Cart cleared' });
    });
});

// ============================================================
//  SECTOR 5 — WISHLIST
// ============================================================

app.post('/api/v1/wishlist/add', (req, res) => {
    const { user_id, product_id } = req.body;
    if (!user_id || !product_id) return res.status(400).json({ message: 'user_id and product_id required' });
    db.query('INSERT IGNORE INTO wishlist (user_id, product_id) VALUES (?, ?)', [user_id, product_id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Added to wishlist' });
    });
});

app.get('/api/v1/wishlist/:userId', (req, res) => {
    const sql = `
        SELECT w.id, p.product_id, p.name, p.price, p.image_url, b.name AS brand_name
        FROM wishlist w
        JOIN products p ON w.product_id = p.product_id
        JOIN brands b ON p.brand_id = b.id
        WHERE w.user_id = ?
    `;
    db.query(sql, [req.params.userId], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.delete('/api/v1/wishlist/remove', (req, res) => {
    const { user_id, product_id } = req.body;
    db.query('DELETE FROM wishlist WHERE user_id = ? AND product_id = ?', [user_id, product_id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Removed from wishlist' });
    });
});


// ============================================================
//  COUPONS
// ============================================================

// User: validate a coupon code
app.post('/api/v1/coupons/validate', (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ message: 'Coupon code required' });
    db.query(
        `SELECT * FROM coupons WHERE UPPER(code) = UPPER(?) AND is_active = 1
         AND (expiry_date IS NULL OR expiry_date >= CURDATE())`,
        [code.trim()], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!results.length) return res.status(404).json({ message: 'Invalid or expired coupon' });
        const coupon = results[0];
        res.json({ valid: true, code: coupon.code, discount_percent: coupon.discount_percent });
    });
});

// Admin: get all coupons
app.get('/api/v1/admin/coupons', (req, res) => {
    db.query('SELECT * FROM coupons ORDER BY created_at DESC', (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// Admin: create coupon
app.post('/api/v1/admin/coupons', (req, res) => {
    const { code, discount_percent, expiry_date } = req.body;
    if (!code || !discount_percent) return res.status(400).json({ message: 'Code and discount required' });
    if (discount_percent < 1 || discount_percent > 100) return res.status(400).json({ message: 'Discount must be 1-100%' });
    // Max 3 coupons
    db.query('SELECT COUNT(*) AS count FROM coupons WHERE is_active = 1', (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        if (rows[0].count >= 3) return res.status(400).json({ message: 'Maximum 3 active coupons allowed. Delete one first.' });
        db.query(
            'INSERT INTO coupons (code, discount_percent, expiry_date) VALUES (UPPER(?), ?, ?)',
            [code.trim(), discount_percent, expiry_date || null], (err2) => {
            if (err2) {
                if (err2.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Coupon code already exists' });
                return res.status(500).json({ error: err2.message });
            }
            res.status(201).json({ message: 'Coupon created' });
        });
    });
});

// Admin: delete coupon
app.delete('/api/v1/admin/coupons/:id', (req, res) => {
    db.query('DELETE FROM coupons WHERE id = ?', [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Coupon deleted' });
    });
});

// ============================================================
//  SECTOR 6 — ORDERS
// ============================================================

app.post('/api/v1/orders/place', (req, res) => {
    const { user_id, total, items, payment_method, delivery_address, payment_intent_id } = req.body;
    if (!user_id || !total || !items) return res.status(400).json({ message: 'Missing fields' });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ message: 'items must be a non-empty array' });
    const method = payment_method || 'COD';
    const productIds = [...new Set(items.map(item => item.product_id))];
    const inList = productIds.map(() => '?').join(',');
    db.query(`SELECT product_id, category FROM products WHERE product_id IN (${inList})`, productIds, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        if (rows.length !== productIds.length) return res.status(400).json({ message: 'One or more products are invalid' });
        const catByPid = {};
        rows.forEach(r => { catByPid[String(r.product_id)] = r.category; });
        for (const item of items) {
            if (isClothingCategory(catByPid[String(item.product_id)])) {
                const sz = normalizeCartSize(item.size);
                if (!sz) {
                    return res.status(400).json({ message: 'Size is required for clothing items', product_id: item.product_id });
                }
            }
        }
        const address  = delivery_address || null;
        const intentId = payment_intent_id || null;
        db.query('INSERT INTO orders (user_id, total, payment_method, delivery_address, payment_intent_id) VALUES (?, ?, ?, ?, ?)',
            [user_id, total, method, address, intentId], (err2, result) => {
            if (err2) return res.status(500).json({ error: err2.message });
            const order_id = result.insertId;
            const values = items.map(item => [
                order_id,
                item.product_id,
                normalizeCartSize(item.size),
                item.quantity,
                item.price
            ]);
            db.query('INSERT INTO order_items (order_id, product_id, size, quantity, price) VALUES ?', [values], (err3) => {
                if (err3) return res.status(500).json({ error: err3.message });
                // Decrement stock for each ordered item
                items.forEach(item => {
                    db.query(
                        'UPDATE products SET stock = GREATEST(0, stock - ?) WHERE product_id = ?',
                        [item.quantity, item.product_id], () => {}
                    );
                });
                db.query('DELETE FROM cart WHERE user_id = ?', [user_id], (err4) => {
                    if (err4) return res.status(500).json({ error: err4.message });
                    db.query('INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
                        [user_id, 'Order Placed!', `Your order #LV-${order_id} has been placed successfully.`, 'order_placed'], () => {});

                    // Send order confirmation email
                    db.query('SELECT name, email FROM users WHERE id = ?', [user_id], (e5, users) => {
                        if (!e5 && users.length) {
                            const { name, email } = users[0];
                            const itemRows = items.map(item =>
                                `<tr>
                                    <td style="padding:8px 0;color:#333;font-size:13px;">${item.product_id}</td>
                                    <td style="padding:8px 0;color:#333;font-size:13px;text-align:center;">x${item.quantity}</td>
                                    <td style="padding:8px 0;color:#1A3A6B;font-size:13px;text-align:right;font-weight:bold;">Rs. ${item.price}</td>
                                </tr>`
                            ).join('');
                            sendEmail({
                                to     : email,
                                subject: `Order Confirmed — #LV-${order_id} 🛍️`,
                                html   : emailTemplate('Order Confirmed!', `
                                    <p style="color:#555;font-size:15px;">Hi <strong>${name}</strong>,</p>
                                    <p style="color:#555;font-size:15px;">Your order has been placed successfully. We'll notify you once it's shipped!</p>
                                    <div style="background:#f0f8ff;border-radius:10px;padding:16px;margin:20px 0;">
                                        <p style="margin:0 0 10px;color:#1A3A6B;font-weight:bold;font-size:14px;">Order #LV-${order_id}</p>
                                        <table style="width:100%;border-collapse:collapse;">
                                            <tr style="border-bottom:1px solid #e0e0e0;">
                                                <th style="padding:6px 0;color:#888;font-size:12px;text-align:left;">Product</th>
                                                <th style="padding:6px 0;color:#888;font-size:12px;text-align:center;">Qty</th>
                                                <th style="padding:6px 0;color:#888;font-size:12px;text-align:right;">Price</th>
                                            </tr>
                                            ${itemRows}
                                            <tr style="border-top:2px solid #e0e0e0;">
                                                <td colspan="2" style="padding:10px 0;font-weight:bold;color:#1A3A6B;font-size:14px;">Total</td>
                                                <td style="padding:10px 0;font-weight:bold;color:#29B6F6;font-size:15px;text-align:right;">Rs. ${total}</td>
                                            </tr>
                                        </table>
                                    </div>
                                    <p style="color:#555;font-size:13px;"><strong>Payment:</strong> ${method}</p>
                                    ${address ? `<p style="color:#555;font-size:13px;"><strong>Delivery to:</strong> ${address}</p>` : ''}
                                    <p style="color:#aaa;font-size:12px;margin-top:20px;">Thank you for shopping with LibasVerse!</p>
                                `),
                            });
                        }
                    });

                    res.status(201).json({ message: 'Order placed successfully', order_id });
                });
            });
        });
    });
});

app.get('/api/v1/orders/:userId', (req, res) => {
    const sql = `
        SELECT o.id AS order_id, o.total, o.status, o.payment_method,
               o.delivery_address, o.created_at,
               oi.quantity, oi.price, oi.size, oi.product_id,
               p.name AS product_name, p.image_url, b.name AS brand_name
        FROM orders o
        JOIN order_items oi ON o.id = oi.order_id
        JOIN products p ON oi.product_id = p.product_id
        JOIN brands b ON p.brand_id = b.id
        WHERE o.user_id = ?
        ORDER BY o.created_at DESC
    `;
    db.query(sql, [req.params.userId], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.put('/api/v1/orders/cancel', (req, res) => {
    const { order_id } = req.body;
    db.query('SELECT user_id, payment_intent_id FROM orders WHERE id = ?', [order_id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!rows.length) return res.status(404).json({ message: 'Order not found' });
        const { user_id, payment_intent_id } = rows[0];
        // Stripe orders → request refund; COD orders → cancel immediately
        const newStatus = payment_intent_id ? 'Refund Requested' : 'Cancelled';
        db.query('UPDATE orders SET status = ? WHERE id = ?', [newStatus, order_id], (err2) => {
            if (err2) return res.status(500).json({ error: err2.message });
            const notifTitle   = payment_intent_id ? 'Refund Requested'  : 'Order Cancelled';
            const notifMessage = payment_intent_id
                ? `Your refund request for order #LV-${order_id} has been submitted. Admin will review and process it shortly.`
                : `Your order #LV-${order_id} has been cancelled.`;
            const notifType    = payment_intent_id ? 'refund_requested' : 'order_cancelled';
            db.query('INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
                [user_id, notifTitle, notifMessage, notifType], () => {});
            res.json({ message: newStatus });
        });
    });
});

// ── Admin: get all refund requests ───────────────────────────
app.get('/api/v1/admin/refund-requests', (req, res) => {
    const sql = `
        SELECT o.id AS order_id, o.total, o.status, o.payment_intent_id,
               o.delivery_address, o.created_at,
               u.name AS customer_name, u.email AS customer_email
        FROM orders o
        JOIN users u ON o.user_id = u.id
        WHERE o.status = 'Refund Requested'
        ORDER BY o.created_at DESC
    `;
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// ── Admin: approve refund — fires Stripe + updates status ────
app.post('/api/v1/admin/approve-refund/:orderId', async (req, res) => {
    const order_id = req.params.orderId;
    db.query('SELECT user_id, payment_intent_id, total FROM orders WHERE id = ?', [order_id], async (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!rows.length) return res.status(404).json({ message: 'Order not found' });
        const { user_id, payment_intent_id } = rows[0];
        if (!payment_intent_id) return res.status(400).json({ message: 'No Stripe payment found for this order' });
        try {
            if (stripe) {
                await stripe.refunds.create({ payment_intent: payment_intent_id });
            }
            db.query("UPDATE orders SET status = 'Refunded' WHERE id = ?", [order_id], (err2) => {
                if (err2) return res.status(500).json({ error: err2.message });
                // Restore stock — same as cancellation
                db.query('SELECT product_id, quantity FROM order_items WHERE order_id = ?', [order_id], (e3, items) => {
                    if (!e3 && items.length) {
                        items.forEach(item => {
                            db.query(
                                'UPDATE products SET stock = stock + ? WHERE product_id = ?',
                                [item.quantity, item.product_id], () => {}
                            );
                        });
                    }
                });
                db.query('INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
                    [user_id, 'Refund Approved!',
                     `Your refund for order #LV-${order_id} has been approved. Amount will reflect within 3-5 business days.`,
                     'refund_approved'], () => {});
                res.json({ message: 'Refund processed successfully' });
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
});

app.put('/api/v1/orders/dispatch', (req, res) => {
    const { order_id } = req.body;
    db.query("UPDATE orders SET status = 'Shipped' WHERE id = ?", [order_id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        db.query('SELECT user_id FROM orders WHERE id = ?', [order_id], (e2, rows) => {
            if (!e2 && rows.length) {
                db.query('INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
                    [rows[0].user_id, 'Order Shipped!', `Your order #LV-${order_id} is on its way!`, 'order_shipped'], () => {});
            }
        });
        res.json({ message: 'Order dispatched' });
    });
});

// ============================================================
//  SECTOR 6b — STRIPE
// ============================================================

app.post('/api/v1/stripe/create-payment-intent', async (req, res) => {
    if (!stripe) {
        return res.status(503).json({
            error: 'Stripe is not configured. Set STRIPE_SECRET_KEY in .env (your sk_test_ or sk_live_ secret key, not pk_).'
        });
    }
    const { amount, currency } = req.body;
    try {
        const paymentIntent = await stripe.paymentIntents.create({
            amount  : amount,
            currency: currency || 'pkr',
        });
        res.json({ clientSecret: paymentIntent.client_secret });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  SECTOR 7 — BRAND
// ============================================================

app.post('/api/v1/brand/login', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Email and password are required' });
    db.query('SELECT * FROM brands WHERE email = ? AND password = ?', [email, password], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        if (results.length === 0) return res.status(401).json({ message: 'Invalid email or password' });
        const brand = results[0];
        delete brand.password;
        res.json({ message: 'Login successful', brand });
    });
});

app.get('/api/v1/brand/orders/:brandId', (req, res) => {
    const sql = `
        SELECT o.id AS order_id, o.total, o.status, o.payment_method,
               o.delivery_address, o.created_at,
               oi.quantity, oi.price, oi.size,
               p.name AS product_name, p.image_url,
               u.name AS customer_name, u.email AS customer_email
        FROM orders o
        JOIN order_items oi ON o.id = oi.order_id
        JOIN products p ON oi.product_id = p.product_id
        JOIN users u ON o.user_id = u.id
        WHERE p.brand_id = ? AND o.status NOT IN ('Cancelled', 'Refunded', 'Refund Requested')
        ORDER BY o.created_at DESC
    `;
    db.query(sql, [req.params.brandId], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.get('/api/v1/brand/products/:brandId', (req, res) => {
    db.query('SELECT COUNT(*) as count FROM products WHERE brand_id = ?', [req.params.brandId], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ count: results[0].count });
    });
});

// Brand: get current sale status
app.get('/api/v1/brand/sale/:brandId', (req, res) => {
    db.query('SELECT sale_percent, sale_until FROM brands WHERE id = ?', [req.params.brandId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!rows.length) return res.status(404).json({ message: 'Brand not found' });
        const { sale_percent, sale_until } = rows[0];
        const isActive = sale_percent > 0 && (sale_until === null || new Date(sale_until) >= new Date());
        res.json({
            sale_percent,
            sale_until: sale_until ? sale_until.toISOString().substring(0, 10) : null,
            is_active: isActive,
        });
    });
});

// Brand: set flat sale
app.put('/api/v1/brand/sale/:brandId', (req, res) => {
    const { sale_percent, sale_until } = req.body;
    const pct = parseInt(sale_percent);
    if (!pct || pct < 1 || pct > 90) return res.status(400).json({ message: 'Discount must be between 1% and 90%' });
    db.query('UPDATE brands SET sale_percent = ?, sale_until = ? WHERE id = ?',
        [pct, sale_until || null, req.params.brandId], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Sale started successfully' });
    });
});

// Brand: end flat sale
app.put('/api/v1/brand/sale/:brandId/end', (req, res) => {
    db.query('UPDATE brands SET sale_percent = 0, sale_until = NULL WHERE id = ?', [req.params.brandId], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Sale ended' });
    });
});

app.get('/api/v1/brand/products-list/:brandId', (req, res) => {
    db.query('SELECT product_id, name, category, price, image_url, stock, tag FROM products WHERE brand_id = ? ORDER BY name ASC',
        [req.params.brandId], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// ============================================================
//  SECTOR 7b — BRAND PAYMENTS
// ============================================================

// Admin sends a payment to a brand
app.post('/api/v1/admin/pay-brand', (req, res) => {
    const { brand_id, amount, note } = req.body;
    if (!brand_id || !amount) return res.status(400).json({ message: 'brand_id and amount are required' });
    db.query('INSERT INTO brand_payments (brand_id, amount, note) VALUES (?, ?, ?)',
        [brand_id, amount, note || ''], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Payment sent' });
    });
});

// Admin gets payment summary per brand (total paid + confirmed)
app.get('/api/v1/admin/brand-payment-summary', (req, res) => {
    const sql = `
        SELECT b.id, b.name,
            COALESCE(SUM(bp.amount), 0) AS total_paid,
            COALESCE(SUM(CASE WHEN bp.status = 'confirmed' THEN bp.amount ELSE 0 END), 0) AS confirmed
        FROM brands b
        LEFT JOIN brand_payments bp ON b.id = bp.brand_id
        GROUP BY b.id, b.name
    `;
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// Brand gets their own payments list
app.get('/api/v1/brand/payments/:brandId', (req, res) => {
    db.query('SELECT * FROM brand_payments WHERE brand_id = ? ORDER BY created_at DESC',
        [req.params.brandId], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// Brand confirms/acknowledges a payment
app.put('/api/v1/brand/payments/:id/confirm', (req, res) => {
    db.query("UPDATE brand_payments SET status = 'confirmed' WHERE id = ?", [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Payment confirmed' });
    });
});

// ============================================================
//  SECTOR 8 — ADDRESS
// ============================================================

app.get('/api/v1/addresses/:userId', (req, res) => {
    db.query('SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC', [req.params.userId], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.post('/api/v1/addresses/add', (req, res) => {
    const { user_id, full_name, phone, address, city, is_default } = req.body;
    if (is_default) {
        db.query('UPDATE addresses SET is_default = 0 WHERE user_id = ?', [user_id], () => {});
    }
    db.query('INSERT INTO addresses (user_id, full_name, phone, address, city, is_default) VALUES (?, ?, ?, ?, ?, ?)',
        [user_id, full_name, phone, address, city, is_default ? 1 : 0], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.status(201).json({ message: 'Address added', id: result.insertId });
    });
});

app.delete('/api/v1/addresses/delete', (req, res) => {
    const { address_id, user_id } = req.body;
    db.query('DELETE FROM addresses WHERE id = ? AND user_id = ?', [address_id, user_id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Address deleted' });
    });
});

// ============================================================
//  SECTOR 9 — ADMIN
// ============================================================

app.post('/api/v1/admin/login', (req, res) => {
    const { email, password } = req.body;
    db.query('SELECT * FROM admins WHERE email = ? AND password = ?', [email, password], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        if (results.length === 0) return res.status(401).json({ message: 'Invalid credentials' });
        res.json({ message: 'Admin login successful' });
    });
});

app.get('/api/v1/admin/stats', (req, res) => {
    const sql = `SELECT
        (SELECT COUNT(*) FROM users) as total_users,
        (SELECT COUNT(*) FROM brands) as total_brands,
        (SELECT COUNT(*) FROM products) as total_products,
        (SELECT COUNT(*) FROM orders WHERE status NOT IN ('Cancelled','Refund Requested','Refunded')) as total_orders,
        (SELECT COALESCE(SUM(total), 0) FROM orders WHERE status NOT IN ('Cancelled','Refund Requested','Refunded')) as total_revenue`;
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results[0]);
    });
});

app.get('/api/v1/admin/brand-stats', (req, res) => {
    const sql = `
        SELECT b.name,
               COUNT(DISTINCT p.product_id) as total_products,
               COUNT(DISTINCT o.id) as total_orders,
               COALESCE(SUM(CASE WHEN o.id IS NOT NULL THEN oi.price * oi.quantity ELSE 0 END), 0) as total_revenue
        FROM brands b
        LEFT JOIN products p ON p.brand_id = b.id
        LEFT JOIN order_items oi ON oi.product_id = p.product_id
        LEFT JOIN orders o ON o.id = oi.order_id AND o.status IN ('Shipped', 'Delivered')
        GROUP BY b.id, b.name
        ORDER BY total_revenue DESC`;
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.get('/api/v1/admin/orders', (req, res) => {
    const sql = `
        SELECT o.id as order_id, o.total, o.status, o.payment_method, o.created_at,
               u.name as customer_name
        FROM orders o
        JOIN users u ON o.user_id = u.id
        ORDER BY o.created_at DESC`;
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.get('/api/v1/admin/users', (req, res) => {
    db.query('SELECT id, name, email, created_at FROM users ORDER BY created_at DESC', (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// ============================================================
//  SECTOR 10 — AI OUTFIT RECOMMENDATION
// ============================================================

app.get('/api/v1/ai/recommend', async (req, res) => {
    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${process.env.GEMINI_API_KEY || ''}`, {
            method : 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                contents: [{
                    parts: [{
                        text: 'Give a single short 2-sentence Pakistani fashion outfit recommendation for today. Mention specific clothing types like kurta, shalwar kameez, polo shirt, chino, linen shirt etc. Be concise and friendly.'
                    }]
                }]
            }),
        });
        if (!response.ok) throw new Error('Gemini API error');
        const data = await response.json();
        const text = data.candidates[0].content.parts[0].text;
        res.json({ recommendation: text.trim() });
    } catch (err) {
        console.error("Gemini API Error:", err.message);
        const fallbacks = [
            'Try a classic white shalwar kameez with brown khusa for a timeless traditional look. Perfect for casual gatherings or a relaxed Friday at the office.',
            'Pair an Avant Garde polo shirt with slim-fit chinos for a smart-casual outfit. Add clean white sneakers to complete the modern look.',
            'A printed lawn kurta with straight-cut trousers is the ideal combo for warm Pakistani weather. Keep accessories minimal for a clean, fresh appearance.',
        ];
        const tip = fallbacks[Math.floor(Math.random() * fallbacks.length)];
        res.json({ recommendation: tip });
    }
});

// ============================================================
//  SECTOR 11 — SEARCH
// ============================================================

app.get('/api/v1/search', (req, res) => {
    const { q } = req.query;
    if (!q || q.trim() === '') return res.json([]);
    const term = `%${q.trim()}%`;
    const sql = `
        SELECT p.*, b.name AS brand_name
        FROM products p
        JOIN brands b ON p.brand_id = b.id
        WHERE p.name LIKE ? OR b.name LIKE ? OR p.category LIKE ?
        ORDER BY p.name ASC
        LIMIT 30
    `;
    db.query(sql, [term, term, term], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// ============================================================
//  SECTOR 12 — RECOMMENDATIONS
// ============================================================

app.get('/api/v1/recommendations/:userId', (req, res) => {
    const userId = req.params.userId;
    const sql = `
        SELECT DISTINCT p.category FROM products p
        WHERE p.product_id IN (
            SELECT product_id FROM wishlist WHERE user_id = ?
            UNION
            SELECT product_id FROM cart WHERE user_id = ?
            UNION
            SELECT oi.product_id FROM order_items oi
            JOIN orders o ON oi.order_id = o.id
            WHERE o.user_id = ?
        )
    `;
    db.query(sql, [userId, userId, userId], (err, catResults) => {
        if (err) return res.status(500).json({ error: err.message });

        if (catResults.length === 0) {
            const popularSql = `
                SELECT p.*, b.name AS brand_name, COUNT(oi.product_id) AS order_count
                FROM products p
                JOIN brands b ON p.brand_id = b.id
                LEFT JOIN order_items oi ON oi.product_id = p.product_id
                GROUP BY p.product_id
                ORDER BY order_count DESC
                LIMIT 6
            `;
            db.query(popularSql, (err2, popular) => {
                if (err2) return res.status(500).json({ error: err2.message });
                res.json({ source: 'popular', products: popular });
            });
            return;
        }

        const categories = catResults.map(r => r.category);
        const placeholders = categories.map(() => '?').join(', ');
        const recSql = `
            SELECT p.*, b.name AS brand_name
            FROM products p
            JOIN brands b ON p.brand_id = b.id
            WHERE p.category IN (${placeholders})
            AND p.product_id NOT IN (
                SELECT product_id FROM wishlist WHERE user_id = ?
                UNION
                SELECT product_id FROM cart WHERE user_id = ?
            )
            ORDER BY RAND()
            LIMIT 6
        `;
        db.query(recSql, [...categories, userId, userId], (err3, recs) => {
            if (err3) return res.status(500).json({ error: err3.message });
            res.json({ source: 'personalized', products: recs });
        });
    });
});

// ============================================================
//  SECTOR 13 — REVIEWS
// ============================================================

app.get('/api/v1/reviews/user/:userId', (req, res) => {
    db.query('SELECT COUNT(*) AS count FROM reviews WHERE user_id = ?', [req.params.userId], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ count: results[0].count });
    });
});

app.get('/api/v1/reviews/:productId', (req, res) => {
    const sql = `
        SELECT r.id, r.user_id, r.rating, r.comment, r.created_at,
               u.name AS user_name
        FROM reviews r
        JOIN users u ON r.user_id = u.id
        WHERE r.product_id = ?
        ORDER BY r.created_at DESC
    `;
    db.query(sql, [req.params.productId], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.post('/api/v1/reviews/add', (req, res) => {
    const { user_id, product_id, rating, comment } = req.body;
    if (!user_id || !product_id || !rating) return res.status(400).json({ message: 'Missing fields' });
    db.query(
        'INSERT INTO reviews (user_id, product_id, rating, comment) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE rating = ?, comment = ?',
        [user_id, product_id, rating, comment || '', rating, comment || ''],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            db.query(
                'SELECT ROUND(AVG(rating),1) AS avg_r, COUNT(*) AS cnt FROM reviews WHERE product_id = ?',
                [product_id], (e2, rows) => {
                    if (e2 || !rows.length) return;
                    const { avg_r, cnt } = rows[0];
                    db.query('UPDATE products SET ratings = ?, reviews_count = ? WHERE product_id = ?',
                        [avg_r, cnt, product_id], () => {});
                }
            );
            res.status(201).json({ message: 'Review submitted' });
        }
    );
});

// ============================================================
//  SECTOR 14 — NOTIFICATIONS
// ============================================================

app.get('/api/v1/notifications/:userId', (req, res) => {
    const sql = `
        SELECT * FROM notifications
        WHERE user_id = ? OR user_id IS NULL
        ORDER BY created_at DESC
        LIMIT 50
    `;
    db.query(sql, [req.params.userId], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.put('/api/v1/notifications/mark-read/:id', (req, res) => {
    db.query('UPDATE notifications SET is_read = 1 WHERE id = ?', [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Marked as read' });
    });
});

app.put('/api/v1/notifications/mark-all-read/:userId', (req, res) => {
    const sql = 'SELECT id FROM notifications WHERE user_id = ? OR user_id IS NULL';
    db.query(sql, [req.params.userId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!rows.length) return res.json({ message: 'Nothing to mark' });
        const ids = rows.map(r => r.id);
        db.query('UPDATE notifications SET is_read = 1 WHERE id IN (?)', [ids], (err2) => {
            if (err2) return res.status(500).json({ error: err2.message });
            res.json({ message: 'All marked as read' });
        });
    });
});

app.delete('/api/v1/notifications/:id', (req, res) => {
    db.query('DELETE FROM notifications WHERE id = ?', [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Deleted' });
    });
});

app.post('/api/v1/notifications/announce', (req, res) => {
    const { title, message, sender_name } = req.body;
    if (!title || !message) return res.status(400).json({ message: 'title and message required' });
    const from = sender_name ? sender_name : 'Libas Verse';
    const fullMessage = `${message}\n\n— ${from}`;
    db.query('INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
        [null, title, fullMessage, 'announcement'], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.status(201).json({ message: 'Announcement sent' });
    });
});

// ============================================================
//  START SERVER
// ============================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Libas-Verse running on http://localhost:${PORT}`));
