// Check the actual services: a running supervisor alone is not readiness.
const ports = [
  process.env.PAYMENT_API_PORT || '6100',
  process.env.CHECKOUT_PORTAL_PORT || '7000',
  process.env.MERCHANT_ADMIN_PORT || '6001'
];
try {
  await Promise.all(ports.map(async port => {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok || (await response.json()).status !== 'UP') {
      throw new Error(`Service on port ${port} is not ready`);
    }
  }));
} catch (error) {
  console.error(`Gateway health check failed: ${error.message}`);
  process.exitCode = 1;
}
