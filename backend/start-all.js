// Server and bot share one database/cache, avoiding competing file writers.
require("./server").ready.then(() => require("./bot"));
