require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const nodemailer = require('nodemailer');
const { MongoClient } = require('mongodb');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const API = 'https://bpay.binanceapi.com';
let codes, orders; // MongoDB collections (free Atlas database)

// Product details (name, price, image) live in products.json.
// The codes you sell live in the database, so nothing is lost when the free server restarts.
function loadProducts(){ return JSON.parse(fs.readFileSync('products.json','utf8')); }

async function binance(path, body){
  const ts = Date.now().toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const json = JSON.stringify(body);
  const sig = crypto.createHmac('sha512', process.env.BINANCE_SECRET)
    .update(ts + '\n' + nonce + '\n' + json + '\n').digest('hex').toUpperCase();
  const res = await fetch(API + path, {
    method:'POST',
    headers:{
      'Content-Type':'application/json',
      'BinancePay-Timestamp': ts,
      'BinancePay-Nonce': nonce,
      'BinancePay-Certificate-SN': process.env.BINANCE_API_KEY,
      'BinancePay-Signature': sig
    },
    body: json
  });
  return res.json();
}

const mailer = nodemailer.createTransport({
  service:'gmail',
  auth:{ user: process.env.MAIL_USER, pass: process.env.MAIL_PASS }
});

// Shop page product list with live stock
app.get('/api/products', async (req, res) => {
  const list = await Promise.all(loadProducts().map(async p => ({
    id:p.id, name:p.name, description:p.description, price:p.price, image:p.image,
    stock: await codes.countDocuments({ productId:p.id, sold:false })
  })));
  res.json(list);
});

// Admin: add codes for a product (send your ADMIN_KEY)
app.post('/api/admin/codes', async (req, res) => {
  if(req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(403).json({ error:'Forbidden' });
  const { productId, list } = req.body;
  await codes.insertMany(list.map(c => ({ productId, code:c, sold:false })));
  res.json({ added: list.length });
});

// Start checkout
app.post('/api/checkout', async (req, res) => {
  const { productId, email } = req.body;
  const product = loadProducts().find(p => p.id === productId);
  if(!product) return res.json({ error:'Product not found' });
  if(await codes.countDocuments({ productId, sold:false }) === 0) return res.json({ error:'Out of stock' });

  const tradeNo = 'NX' + Date.now();
  const result = await binance('/binancepay/openapi/v3/order', {
    env:{ terminalType:'WEB' },
    merchantTradeNo: tradeNo,
    orderAmount: product.price,
    currency:'USDT',
    description: product.name,
    goodsDetails:[{ goodsType:'02', goodsCategory:'Z000', referenceGoodsId:product.id, goodsName:product.name }],
    returnUrl: process.env.SITE_URL + '/thanks.html',
    webhookUrl: process.env.SITE_URL + '/api/binance-webhook'
  });
  if(result.status !== 'SUCCESS') return res.json({ error:'Payment could not start' });

  await orders.insertOne({ tradeNo, productId, email, delivered:false, createdAt:new Date() });
  res.json({ checkoutUrl: result.data.checkoutUrl });
});

// Binance calls this when payment status changes
app.post('/api/binance-webhook', async (req, res) => {
  try {
    const data = JSON.parse(req.body.data || '{}');
    const order = await orders.findOne({ tradeNo: data.merchantTradeNo, delivered:false });
    if(order){
      const check = await binance('/binancepay/openapi/v2/order/query', { merchantTradeNo: order.tradeNo });
      if(check.data && check.data.status === 'PAID'){
        // Lock the order first so it can never be delivered twice
        const lock = await orders.updateOne({ _id:order._id, delivered:false }, { $set:{ delivered:true } });
        if(lock.modifiedCount === 1){
          const item = await codes.findOneAndUpdate(
            { productId:order.productId, sold:false },
            { $set:{ sold:true, tradeNo:order.tradeNo, soldAt:new Date() } },
            { returnDocument:'after' }
          );
          const p = loadProducts().find(x => x.id === order.productId);
          if(!item){
            // Paid but no code left: flag the order and alert both shop owner and buyer
            await orders.updateOne({ _id:order._id }, { $set:{ problem:'out_of_stock' } });
            await mailer.sendMail({ from: process.env.MAIL_USER, to: process.env.MAIL_USER, subject: 'NexaCart Shop: paid order with no stock ' + order.tradeNo, text: 'Customer ' + order.email + ' paid for ' + p.name + ' but no code was left. Deliver manually or refund.' });
            await mailer.sendMail({ from: process.env.MAIL_USER, to: order.email, subject: 'Your NexaCart Shop order: ' + p.name, text: 'Payment received. Your item will be sent to you shortly by our team. Need help? Contact us on WhatsApp or Telegram.' });
          }
          if(item) await mailer.sendMail({
            from: process.env.MAIL_USER,
            to: order.email,
            subject: 'Your NexaCart Shop order: ' + p.name,
            text: 'Thank you for your purchase!\n\nYour item: ' + item.code + '\n\nNeed help? Contact us on WhatsApp or Telegram.'
          });
        }
      }
    }
  } catch(e){ console.error(e); }
  res.json({ returnCode:'SUCCESS', returnMessage:null });
});

MongoClient.connect(process.env.MONGODB_URI).then(client => {
  const db = client.db('nexacart');
  codes = db.collection('codes');
  orders = db.collection('orders');
  app.listen(process.env.PORT || 3000, () => console.log('NexaCart Shop running'));
});
