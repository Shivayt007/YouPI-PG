import crypto from 'node:crypto';
import { PaymentSessionRepository, ReceivingAccountRepository } from '@youpi/db';
import { resolveRuntimeUrls, toPaise, toRupeesString } from '@youpi/common';

const send = (res, code, data) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
};
async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > 8192) throw new Error('Request is too large');
  }
  return JSON.parse(body || '{}');
}

// These routes live behind the single-origin proxy's administrator access gate.
export async function handlePaymentLinks(req, res, { db, merchantRepo, apiBaseUrl }) {
  const merchant = merchantRepo.findAll()[0];
  if (!merchant) { send(res, 400, { error: 'Configure your shop and receiving UPI account first.' }); return; }
  const sessions = new PaymentSessionRepository(db);
  let base;
  try { base = resolveRuntimeUrls(merchant.branding || {}).checkoutUrl; }
  catch { send(res, 400, { error: 'Set your public gateway URL before creating payment links.' }); return; }
  const present = session => ({
    paymentId: session.id, orderId: session.orderId,
    amount: toRupeesString(session.amountPaise), status: session.status,
    purpose: session.metadata?.paymentLinkPurpose || '',
    customerName: session.metadata?.paymentLinkCustomer || '',
    checkoutUrl: `${base}/checkout/${session.id}`,
    createdAt: session.createdAt.toISOString()
  });

  if (req.method === 'GET') {
    const rows = db.query(`SELECT id FROM payment_sessions
      WHERE merchant_id = ? AND json_valid(metadata)
      AND json_extract(metadata, '$.paymentLinkSource') = 'dashboard'
      ORDER BY created_at DESC LIMIT 50`, [merchant.id]);
    send(res, 200, { links: rows.map(row => present(sessions.findById(row.id))) }); return;
  }
  if (req.method !== 'POST') { send(res, 405, { error: 'Method not allowed' }); return; }

  let body, amountPaise, requestId, purpose, customerName;
  try {
    body = await readBody(req);
    amountPaise = toPaise(body.amount);
    if (amountPaise > 100000000n) throw new Error('Enter an amount up to ₹10,00,000.');
    requestId = body.requestId || crypto.randomUUID();
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{16,64}$/.test(requestId)) throw new Error('Invalid request identifier. Reload this page.');
    purpose = String(body.purpose || '').trim();
    customerName = String(body.customerName || '').trim();
    if (purpose.length > 160 || customerName.length > 80) throw new Error('Please shorten the customer name or payment description.');
  } catch (error) { send(res, 400, { error: error.message }); return; }

  const receiver = new ReceivingAccountRepository(db).findActiveForMerchant(merchant.id);
  if (!receiver || receiver.upiId === 'merchant@upi' || receiver.isMerchantEnabled === false) {
    send(res, 400, { error: 'Set and activate your receiving UPI ID in Store Settings → Receiving Accounts first.' }); return;
  }

  const orderId = `LINK-${requestId}`;
  const previous = sessions.findByOrderId(merchant.id, orderId);
  if (previous) {
    if (previous.amountPaise !== amountPaise || previous.metadata?.paymentLinkPurpose !== purpose || previous.metadata?.paymentLinkCustomer !== customerName) {
      send(res, 409, { error: 'This request was already used for another payment. Create a new link.' }); return;
    }
    send(res, 200, present(previous)); return;
  }
  try {
    const response = await fetch(`${apiBaseUrl}/api/v1/payments`, {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `payment-link:${requestId}`, 'X-Merchant-Id': merchant.id },
      body: JSON.stringify({
        orderId, amount: toRupeesString(amountPaise), currency: 'INR', method: 'UPI',
        metadata: { paymentLinkSource: 'dashboard', paymentLinkPurpose: purpose, paymentLinkCustomer: customerName }
      })
    });
    const result = await response.json();
    if (!response.ok) { send(res, response.status, { error: result.error || 'Could not create payment link.' }); return; }
    const session = sessions.findById(result.paymentId);
    if (!session) throw new Error('Payment was not saved');
    send(res, 201, present(session));
  } catch {
    send(res, 502, { error: 'The payment service did not respond. Retry this same request; it will not create a duplicate link.' });
  }
}
