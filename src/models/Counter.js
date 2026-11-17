const mongoose = require('mongoose');

/** Named sequences for human references (e.g. special delivery SD-000124). */
const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
});

const Counter = mongoose.model('Counter', counterSchema);

/** The next number of sequence `name` (1, 2, 3 …), atomically. */
Counter.next = async (name) => {
  const row = await Counter.findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' }).lean();
  return row.seq;
};

module.exports = Counter;
