// The worker that checks.mjs kills: it starts one job, says "started", and never finishes it.
//   node check_child.mjs <library> <url>
const [library, url] = process.argv.slice(2);
const { adapter } = await import(`./libs/${library.replaceAll('-', '_')}.mjs`);
const queue = await adapter.open({
    url,
    names: { stuck: { timeoutMs: 2000, maxAttempts: 2 } },
    stall: true,
    handler: async () => {
        process.stdout.write('started\n');
        await new Promise(() => {});
    },
});

await queue.enqueue('stuck', { id: 1 });
await queue.start();
