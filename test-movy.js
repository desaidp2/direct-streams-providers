const { getStreams } = require('./providers/movy.js');

async function run(label, args) {
  const t0 = Date.now();
  const streams = await getStreams(...args);
  console.log(`\n== ${label}: ${streams.length} stream(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  streams.slice(0, 8).forEach((s) =>
    console.log(`- ${s.name} [${s.quality}] ${s.url.slice(0, 100)}... subs=${(s.subtitles || []).length}`)
  );
  return streams;
}

(async () => {
  const movie = await run('Oppenheimer (movie 872585)', ['872585', 'movie']);
  const tv = await run('Breaking Bad S01E01 (tv 1396)', ['1396', 'tv', 1, 1]);
  const missing = await run('Nonexistent (movie 999999999)', ['999999999', 'movie']);
  console.log('\nSUMMARY movie:', movie.length, 'tv:', tv.length, 'missing:', missing.length);
})();
