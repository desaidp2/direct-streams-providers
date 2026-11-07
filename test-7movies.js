const { getStreams } = require('./providers/7movies.js');

async function run(label, args) {
  const streams = await getStreams(...args);
  console.log(`\n== ${label}: ${streams.length} stream(s)`);
  streams.slice(0, 6).forEach((s) =>
    console.log(`- [${s.quality}] ${s.url.slice(0, 110)}... subs=${(s.subtitles || []).length}`)
  );
  return streams;
}

(async () => {
  const movie = await run('Oppenheimer (movie 872585)', ['872585', 'movie']);
  const tv = await run('Breaking Bad S01E01 (tv 1396)', ['1396', 'tv', 1, 1]);
  const missing = await run('Nonexistent (movie 999999999)', ['999999999', 'movie']);
  console.log('\nSUMMARY movie:', movie.length, 'tv:', tv.length, 'missing:', missing.length);
})();
