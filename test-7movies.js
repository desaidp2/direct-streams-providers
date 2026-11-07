const assert = require('assert');
const { getStreams } = require('./providers/7movies.js');

async function run(label, args) {
  const streams = await getStreams(...args);
  console.log(`\n== ${label}: ${streams.length} stream(s)`);
  streams.slice(0, 6).forEach((s) => {
    console.log(`- [${s.quality}] ${s.url.slice(0, 110)}... subs=${(s.subtitles || []).length}`);
    if (s.behaviorHints) {
      assert(s.behaviorHints.notWebReady === true, 'behaviorHints.notWebReady must be true');
      assert(s.behaviorHints.proxyHeaders, 'behaviorHints.proxyHeaders must exist');
      assert(s.behaviorHints.proxyHeaders.request, 'proxyHeaders.request must exist');
      assert.strictEqual(
        s.behaviorHints.proxyHeaders.request['User-Agent'],
        'okhttp/4.12.0',
        'User-Agent in proxyHeaders must be okhttp/4.12.0'
      );
    }
  });
  return streams;
}

(async () => {
  const movie = await run('Oppenheimer (movie 872585)', ['872585', 'movie']);
  assert(movie.length > 0, 'Oppenheimer must return at least 1 stream');

  const tv = await run('Breaking Bad S01E01 (tv 1396)', ['1396', 'tv', 1, 1]);
  assert(tv.length > 0, 'Breaking Bad must return at least 1 stream');

  const missing = await run('Nonexistent (movie 999999999)', ['999999999', 'movie']);
  assert.strictEqual(missing.length, 0, 'Nonexistent title must return 0 streams');

  console.log('\n✓ All assertion tests passed! SUMMARY movie:', movie.length, 'tv:', tv.length, 'missing:', missing.length);
})();
