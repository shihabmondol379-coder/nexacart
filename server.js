require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const { MongoClient } = require('mongodb');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const API = 'https://api.nowpayments.io/v1';
let codes, orders, productsCol; // MongoDB collections (free Atlas database)

// Products live in the database, so you can add and delete them from the admin page
async function loadProducts(){ return productsCol.find({}, { projection:{ _id:0 } }).sort({ createdAt:1 }).toArray(); }
function isAdmin(req){ return req.headers['x-admin-key'] === process.env.ADMIN_KEY; }

async function nowpay(path, method = 'GET', body){
  const res = await fetch(API + path, {
    method,
    headers:{ 'x-api-key': process.env.NOWPAYMENTS_API_KEY, 'Content-Type':'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return res.json();
}

// Sort keys so the signature matches NOWPayments' format
function sortKeys(o){
  if(Array.isArray(o)) return o.map(sortKeys);
  if(o && typeof o === 'object') return Object.keys(o).sort().reduce((r,k) => (r[k] = sortKeys(o[k]), r), {});
  return o;
}

// Shop page product list with live stock
app.get('/api/products', async (req, res) => {
  const list = await Promise.all((await loadProducts()).map(async p => ({
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

// Admin: add a new product
app.post('/api/admin/products', async (req, res) => {
  if(!isAdmin(req)) return res.status(403).json({ error:'Forbidden' });
  const { name, description, price, image } = req.body;
  if(!name || !(Number(price) > 0)) return res.json({ error:'Name and a price above 0 are required' });
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'') + '-' + Date.now().toString(36);
  await productsCol.insertOne({ id, name, description: description || '', price: Number(price), image: image || 'https://placehold.co/400x200?text=' + encodeURIComponent(name), createdAt:new Date() });
  res.json({ ok:true, id });
});

// Admin: delete a product and its unsold codes
app.delete('/api/admin/products/:id', async (req, res) => {
  if(!isAdmin(req)) return res.status(403).json({ error:'Forbidden' });
  await productsCol.deleteOne({ id: req.params.id });
  await codes.deleteMany({ productId: req.params.id, sold:false });
  res.json({ ok:true });
});

// Start checkout: create a NOWPayments invoice
app.post('/api/checkout', async (req, res) => {
  const { productId } = req.body;
  const product = (await loadProducts()).find(p => p.id === productId);
  if(!product) return res.json({ error:'Product not found' });
  if(await codes.countDocuments({ productId, sold:false }) === 0) return res.json({ error:'Out of stock' });

  const tradeNo = 'NX' + Date.now();
  const token = crypto.randomBytes(24).toString('hex'); // secret only this buyer gets
  const inv = await nowpay('/invoice', 'POST', {
    price_amount: product.price,
    price_currency: 'usd',
    order_id: tradeNo,
    order_description: product.name,
    ipn_callback_url: process.env.SITE_URL + '/api/payment-webhook',
    success_url: process.env.SITE_URL + '/thanks.html?order=' + tradeNo + '&token=' + token,
    cancel_url: process.env.SITE_URL
  });
  if(!inv.invoice_url) return res.json({ error:'Payment could not start' });

  await orders.insertOne({ tradeNo, token, productId, price: product.price, delivered:false, createdAt:new Date() });
  res.json({ checkoutUrl: inv.invoice_url, order: tradeNo, token });
});

// NOWPayments calls this when payment status changes
app.post('/api/payment-webhook', async (req, res) => {
  try {
    // 1. Check the signature so fake calls are ignored
    const sig = crypto.createHmac('sha512', process.env.NOWPAYMENTS_IPN_SECRET)
      .update(JSON.stringify(sortKeys(req.body))).digest('hex');
    if(sig !== req.headers['x-nowpayments-sig']) return res.status(401).end();

    const order = await orders.findOne({ tradeNo: req.body.order_id, delivered:false });
    if(order){
      // 2. Double-check the payment directly with NOWPayments
      const check = await nowpay('/payment/' + req.body.payment_id);
      if(check.payment_status === 'finished' && check.order_id === order.tradeNo){
        // 3. Lock the order so it can never be delivered twice
        const lock = await orders.updateOne({ _id:order._id, delivered:false }, { $set:{ delivered:true } });
        if(lock.modifiedCount === 1){
          const item = await codes.findOneAndUpdate(
            { productId:order.productId, sold:false },
            { $set:{ sold:true, tradeNo:order.tradeNo, soldAt:new Date() } },
            { returnDocument:'after' }
          );
          // 4. Save the code on the order; the buyer's page shows it
          if(item) await orders.updateOne({ _id:order._id }, { $set:{ code:item.code } });
          else await orders.updateOne({ _id:order._id }, { $set:{ problem:'out_of_stock' } });
        }
      }
    }
  } catch(e){ console.error(e); }
  res.json({ ok:true });
});

// The thank-you page asks here until the item is ready
app.get('/api/order-status', async (req, res) => {
  const order = await orders.findOne({ tradeNo: String(req.query.order), token: String(req.query.token) });
  if(!order) return res.json({ status:'not_found' });
  if(order.code){
    const p = (await loadProducts()).find(x => x.id === order.productId);
    return res.json({ status:'delivered', product: p ? p.name : '', code: order.code });
  }
  if(order.problem) return res.json({ status:'problem' });
  res.json({ status:'waiting' });
});

MongoClient.connect(process.env.MONGODB_URI).then(async client => {
  const db = client.db('nexacart');
  codes = db.collection('codes');
  orders = db.collection('orders');
  productsCol = db.collection('products');
  // First run only: copy the products from products.json into the database
  if(await productsCol.countDocuments() === 0){
    const start = JSON.parse(fs.readFileSync('products.json','utf8'));
    if(start.length) await productsCol.insertMany(start.map(({ codes, ...p }) => ({ ...p, createdAt:new Date() })));
  }
  app.listen(process.env.PORT || 3000, () => console.log('NexaCart Shop running'));
});
