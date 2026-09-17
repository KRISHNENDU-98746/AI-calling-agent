const express = require('express');

const router = express.Router();

function sendHealth(_req, res) {
  res.status(200).json({
    status: 'ok',
    service: 'ai-appointment-agent',
  });
}

router.get('/health', sendHealth);
router.get('/health/', sendHealth);
router.head('/health', (_req, res) => {
  res.status(200).end();
});

module.exports = router;
