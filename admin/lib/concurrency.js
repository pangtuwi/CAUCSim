/**
 * Map over `items` running at most `limit` calls to `fn` at once, preserving
 * input order in the result.
 *
 * The CFD backend fans out over every job key with a bare Promise.all, which is
 * fine at twenty jobs and not at five hundred — S3 starts refusing connections
 * and the whole listing fails rather than degrading. Everything here that
 * fetches per-object goes through this instead.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  const width = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;

  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: width }, worker));
  return results;
}

module.exports = { mapWithConcurrency };
