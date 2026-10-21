const { Router } = require('express');
const placeController = require('../controllers/placeController');
const rateLimit = require('../middleware/rateLimit');

const router = Router();

// Public (vendor registration uses it before sign-in), so limit per IP.
const placesLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 90,
  code: 'PLACE_SEARCH_RATE_LIMITED',
  message: 'Too many place searches. Please wait a moment and try again.',
});

router.get('/places/autocomplete', placesLimit, placeController.autocomplete);
router.get('/places/details', placesLimit, placeController.details);

module.exports = router;
