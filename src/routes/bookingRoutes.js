const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const rateLimit = require('../middleware/rateLimit');
const requireAuth = require('../middleware/requireAuth');
const { optionalCustomer } = require('./tableRoutes');
const reservationService = require('../services/kitchen/reservationService');

/**
 * Public table booking on a kitchen's page. Guests need no account; the
 * private booking token (shown once, kept hashed) travels in the
 * X-Booking-Token header to view or cancel the booking.
 */
const router = Router();
const readLimit = rateLimit({ windowMs: 60 * 1000, max: 60, code: 'RATE_LIMITED', message: 'Too many requests. Please slow down.' });
const bookLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 5, code: 'BOOKING_RATE_LIMITED', message: 'Too many bookings from this network. Please try again later.' });
const json = (fn, status = 200) => asyncHandler(async (req, res) => res.status(status).json(await fn(req)));

router.get('/mine', requireAuth, json((req) => reservationService.mine(req.customer._id)));
router.get('/manage', readLimit, json((req) => reservationService.publicGet(req.headers['x-booking-token'])));
router.post('/manage/cancel', bookLimit, json((req) => reservationService.publicCancel(req.headers['x-booking-token'])));
router.get('/kitchens/:vendor_id/slots', readLimit, json((req) => reservationService.publicSlots(req.params.vendor_id, req.query)));
router.post('/kitchens/:vendor_id', bookLimit, optionalCustomer, json((req) => reservationService.publicCreate(req.params.vendor_id, req.body, req.customer || null), 201));

module.exports = router;
