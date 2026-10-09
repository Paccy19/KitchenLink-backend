const bcrypt = require('bcryptjs');

const BCRYPT_ROUNDS = 10;

const hashPassword = (plain) => bcrypt.hash(String(plain), BCRYPT_ROUNDS);

const comparePassword = (plain, hash) => bcrypt.compare(String(plain), String(hash));

module.exports = { hashPassword, comparePassword, BCRYPT_ROUNDS };
