const parsePagination = (query = {}, { defaultLimit, maxLimit }) => {
  const parsePositiveInt = (value, fallback) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  };

  const limit = Math.min(
    parsePositiveInt(query.limit, defaultLimit),
    maxLimit
  );
  const page = parsePositiveInt(query.page, 1);
  return { limit, page, offset: (page - 1) * limit };
};

module.exports = parsePagination;
