// Preloaded into repomix: report MD_THREADS CPUs instead of the host's count.
const os = require("node:os");
const n = Math.max(1, parseInt(process.env.MD_THREADS || "1", 10) || 1);
os.availableParallelism = () => n;
const cpus = os.cpus.bind(os);
os.cpus = () => cpus().slice(0, n);
