/**
 * Shared Mongoose `timestamps` option.
 *
 * The API contract (and every repository/serializer in this project) uses
 * snake_case `created_at` / `updated_at`, so schemas must write those field
 * names instead of Mongoose's camelCase defaults.
 */
module.exports = { createdAt: 'created_at', updatedAt: 'updated_at' };
