const assert = require('assert');
const { getStreams } = require('./providers/movy.js');

async function run(label, args) {
  const t0 = Date.now();
  const streams = await getStreams(...args);
  console.log(`\n== ${label}: ${streams.length} stream(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  streams.slice(0, 8).forEach((s) => {
    console.log(`- ${s.name} [${s.quality}] ${s.url.slice(0, 100)}... subs=${(s.subtitles || []).length}`);
    assert(s.behaviorHints, 's.behaviorHints must exist');
    assert(s.behaviorHints.notWebReady === true, 's.behaviorHints.notWebReady must be true');
    assert(s.behaviorHints.proxyHeaders, 's.behaviorHints.proxyHeaders must exist');
    assert(s.behaviorHints.proxyHeaders.request, 'proxyHeaders.request must exist');
    assert(s.behaviorHints.proxyHeaders.request.Referer, 'Referer must be set in proxyHeaders.request');
    assert.strictEqual(s.behaviorHints.proxyHeaders.request['User-Agent'], 'okhttp/4.12.0');
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

  console.log('\n✓ All Movy assertion tests passed! SUMMARY movie:', movie.length, 'tv:', tv.length, 'missing:', missing.length);
})();
