/**
 * An offline registry for the reuse survey's labelled set (design-stage
 * DS-P7-7): npm's search, GitHub's repository search, PyPI's JSON API and
 * deps.dev's version endpoint, answered from one fixed corpus of real
 * packages, their descriptions, keywords and licences written from memory
 * as published in 2025–2026 and their weekly downloads or stars rounded,
 * so approximate; written before either ranking was measured against it
 * and not edited afterwards.
 *
 * The searches imitate their services, not the survey: npm matches any query
 * word (a word matches its plural and its "-es" form) in a name, description
 * or keyword and orders by words matched, then downloads, six at most;
 * GitHub matches every word in a name, description or topic and orders by
 * stars (`sort=stars`), six at most. Neither knows the labels. A package
 * released more than two years before the run is dated so, as the real one
 * is (minimist, node-fetch, jsonwebtoken, pdf-lib), and the maintenance
 * floor drops it.
 */

type Npm = [
  name: string,
  description: string,
  keywords: string[],
  weekly: number,
  license: string,
  date: string,
];

// biome-ignore format: a corpus, one package per line
const NPM: Npm[] = [
  // Command-line arguments.
  ["commander", "the complete solution for node.js command-line programs", ["commander", "command", "option", "parser", "cli", "argument", "args", "argv"], 180_000_000, "MIT", "2025-09-12"],
  ["yargs", "yargs the modern, pirate-themed, successor to optimist.", ["argument", "args", "option", "parser", "parsing", "cli", "command"], 90_000_000, "MIT", "2025-05-30"],
  ["yargs-parser", "the mighty option parser used by yargs", ["argument", "parser", "yargs", "command", "cli", "parsing", "option", "args", "argument"], 90_000_000, "ISC", "2025-05-30"],
  ["minimist", "parse argument options", ["argv", "getopt", "parser", "optimist"], 60_000_000, "MIT", "2022-10-19"],
  ["meow", "CLI app helper", ["cli", "bin", "util", "utility", "helper", "argv", "command", "line", "parser", "option", "flags", "input"], 20_000_000, "MIT", "2025-03-01"],
  ["cac", "Simple yet powerful framework for building command-line apps.", ["cli", "commander", "meow", "minimist"], 12_000_000, "MIT", "2025-01-20"],
  ["arg", "Unopinionated, no-frills CLI argument parser", [], 20_000_000, "MIT", "2023-01-10"],
  ["command-line-args", "A mature, feature-complete library to parse command-line options.", ["argv", "parse", "argument", "args", "option", "options", "parser", "parsing", "cli", "command", "line"], 8_000_000, "MIT", "2024-10-01"],
  ["@types/yargs", "TypeScript definitions for yargs", [], 50_000_000, "MIT", "2025-08-01"],
  // JSON Schema and validation.
  ["ajv", "Another JSON Schema Validator", ["JSON", "schema", "validator", "validation", "jsonschema", "json-schema", "json-schema-validator", "json-schema-validation"], 150_000_000, "MIT", "2025-07-10"],
  ["zod", "TypeScript-first schema declaration and validation library with static type inference", ["typescript", "schema", "validation", "type", "inference"], 40_000_000, "MIT", "2025-09-01"],
  ["joi", "Object schema validation", ["schema", "validation"], 12_000_000, "BSD-3-Clause", "2024-12-01"],
  ["jsonschema", "A fast and easy to use JSON Schema validator", ["json", "schema", "jsonschema", "validator", "validation"], 5_000_000, "MIT", "2024-08-20"],
  ["json-schema-traverse", "Traverse JSON Schema passing each schema object to callback", ["JSON-Schema", "traverse", "iterate"], 150_000_000, "MIT", "2020-11-30"],
  ["@types/json-schema", "TypeScript definitions for json-schema", [], 80_000_000, "MIT", "2024-11-10"],
  ["yup", "Dead simple Object schema validation", ["validation", "schema"], 7_000_000, "MIT", "2024-10-10"],
  ["ajv-formats", "Format validation for Ajv v7+", ["Ajv", "JSON-Schema", "format", "validation"], 60_000_000, "MIT", "2024-04-01"],
  // Dates.
  ["date-fns", "Modern JavaScript date utility library", ["date", "time", "datepicker", "calendar", "format", "parse", "utility"], 30_000_000, "MIT", "2025-09-10"],
  ["dayjs", "2KB immutable date time library alternative to Moment.js with the same modern API", ["dayjs", "date", "time", "immutable", "moment"], 25_000_000, "MIT", "2025-06-01"],
  ["luxon", "Immutable date wrapper", ["date", "immutable"], 12_000_000, "MIT", "2025-04-01"],
  ["moment", "Parse, validate, manipulate, and display dates", ["moment", "date", "time", "parse", "format", "validate", "i18n", "l10n"], 25_000_000, "MIT", "2023-12-27"],
  ["dateformat", "A node.js package for Steven Levithan's excellent dateFormat() function.", ["date", "format"], 10_000_000, "MIT", "2022-01-01"],
  ["date-format", "Formatting Date objects as strings since 2013", ["date", "format", "string"], 15_000_000, "MIT", "2023-11-15"],
  // Email.
  ["nodemailer", "Easy as cake e-mail sending from your Node.js applications", ["Nodemailer"], 6_000_000, "MIT-0", "2025-09-20"],
  ["smtp-server", "Create custom SMTP servers on the fly", ["SMTP"], 300_000, "MIT-0", "2025-06-01"],
  ["emailjs", "send text/html emails and attachments (files, streams and strings) from node.js to any smtp server", ["smtp", "email", "mail"], 150_000, "MIT", "2024-09-30"],
  ["@sendgrid/mail", "Twilio SendGrid NodeJS mail service", ["sendgrid", "email", "mail"], 3_000_000, "MIT", "2025-04-01"],
  ["email-validator", "Provides a fast, pretty robust e-mail validator. Only checks form, not function.", ["email", "validation"], 1_000_000, "Unlicense", "2023-05-01"],
  ["mailparser", "Parse e-mails", ["mail", "email", "parser"], 1_000_000, "MIT", "2025-05-01"],
  ["nodemailer-smtp-transport", "SMTP transport for Nodemailer", ["SMTP", "Nodemailer"], 300_000, "MIT", "2017-01-01"],
  // CSV.
  ["csv-parse", "CSV parsing implementing the Node.js `stream.Transform` API", ["csv", "parse", "parser", "convert", "tsv", "stream"], 8_000_000, "MIT", "2025-07-01"],
  ["papaparse", "Fast and powerful CSV parser for the browser that supports web workers and streaming large files. Converts CSV to JSON and JSON to CSV.", ["csv", "parse", "parsing", "parser", "delimited", "text", "data", "auto-detect", "comma", "tab", "pipe", "file", "filereader", "stream", "worker", "workers", "thread", "threading", "multi-threaded", "jquery-plugin"], 5_000_000, "MIT", "2025-05-01"],
  ["csv-parser", "Streaming CSV parser that aims for maximum speed as well as compatibility with the csv-spectrum test suite", ["csv", "parser", "fast", "json"], 1_500_000, "MIT", "2023-01-10"],
  ["fast-csv", "CSV parser and writer", ["csv", "parser", "fast", "writer", "csv writer", "CSV"], 4_000_000, "MIT", "2024-01-20"],
  ["csv-stringify", "CSV stringifier implementing the Node.js `stream.Transform` API", ["csv", "stringify", "stringifier", "backend", "frontend"], 5_000_000, "MIT", "2025-07-01"],
  ["csvtojson", "A tool concentrating on converting csv data to JSON with customised parser supporting", ["csv", "csv parser", "parse csv", "csvtojson", "json", "csv to json", "convert csv to json"], 1_000_000, "MIT", "2024-06-01"],
  ["csv", "A mature CSV toolset with simple api, full of options and tested against large datasets.", ["node", "csv", "parser", "parse", "generate", "stringify", "transform", "stream"], 2_000_000, "MIT", "2025-07-01"],
  // Identifiers.
  ["uuid", "RFC9562 UUIDs", ["uuid", "guid", "rfc4122", "rfc9562"], 150_000_000, "MIT", "2025-09-05"],
  ["nanoid", "A tiny (118 bytes), secure URL-friendly unique string ID generator", ["uuid", "random", "id", "url"], 70_000_000, "MIT", "2025-06-01"],
  ["cuid", "Collision-resistant ids optimized for horizontal scaling and performance. For node and browsers.", ["uuid", "guid", "cuid", "unique", "id", "ids", "identifier", "identifiers"], 1_000_000, "MIT", "2022-01-01"],
  ["shortid", "Amazingly short non-sequential url-friendly unique id generator.", ["short", "tiny", "id", "uuid", "bitly", "shorten", "mongoid", "shortid", "tinyid"], 1_000_000, "MIT", "2020-12-01"],
  ["@paralleldrive/cuid2", "Secure, collision-resistant ids optimized for horizontal scaling and performance. Next generation UUIDs.", ["uuid", "guid", "cuid", "unique", "id", "ids", "identifier", "identifiers"], 3_000_000, "MIT", "2024-11-01"],
  ["hyperid", "Uber-fast unique id generation, for Node.js and the browser", ["id", "unique"], 400_000, "MIT", "2024-08-01"],
  ["ulid", "A universally-unique, lexicographically-sortable, identifier generator", ["ulid", "uuid", "id", "generator", "guid", "unique"], 1_000_000, "MIT", "2025-02-01"],
  ["unique-names-generator", "Generate unique and memorable names", ["unique", "names", "generator"], 200_000, "MIT", "2022-06-01"],
  // Passwords.
  ["bcrypt", "A bcrypt library for NodeJS.", ["bcrypt", "password", "auth", "authentication", "encryption", "crypt", "crypto"], 2_500_000, "MIT", "2025-05-01"],
  ["bcryptjs", "Optimized bcrypt in plain JavaScript with zero dependencies, with TypeScript support. Compatible to 'bcrypt'.", ["bcrypt", "password", "auth", "authentication", "encryption", "crypt", "crypto"], 4_000_000, "BSD-3-Clause", "2025-03-01"],
  ["argon2", "An Argon2 library for Node", ["argon2", "crypto", "encryption", "hashing", "password"], 600_000, "MIT", "2025-04-01"],
  ["password-hash", "Password hashing and verification for node.js", ["password", "hash"], 50_000, "MIT", "2013-06-01"],
  ["generate-password", "Easy library for generating unique passwords.", ["password", "generator", "passwords"], 400_000, "MIT", "2022-06-01"],
  ["@types/bcrypt", "TypeScript definitions for bcrypt", [], 2_000_000, "MIT", "2025-02-01"],
  ["hash-wasm", "Lightning fast hash functions for browsers and Node.js using hand-tuned WebAssembly binaries (MD4, MD5, SHA-1, SHA-2, SHA-3, Keccak, BLAKE2, BLAKE3, PBKDF2, Argon2, bcrypt, scrypt, Adler-32, CRC32, CRC32C, RIPEMD-160, HMAC, xxHash, SM3, Whirlpool)", ["hash", "wasm", "webassembly", "md5", "sha-1", "sha-2", "sha-3", "argon2", "bcrypt", "scrypt", "password", "crc32", "xxhash"], 1_000_000, "MIT", "2024-10-01"],
  // JSON Web Tokens.
  ["jsonwebtoken", "JSON Web Token implementation (symmetric and asymmetric)", ["jwt"], 20_000_000, "MIT", "2023-08-30"],
  ["jose", "JWA, JWS, JWE, JWT, JWK, JWKS for Node.js, Browser, Cloudflare Workers, Deno, Bun, and other Web-interoperable runtimes", ["browser", "compact", "decode", "decrypt", "deno", "ecdsa", "eddsa", "encrypt", "flattened", "jose", "json web token", "jsonwebtoken", "jwa", "jwe", "jwk", "jwks", "jws", "jwt", "sign", "verify"], 25_000_000, "MIT", "2025-09-01"],
  ["jwt-decode", "Decode JWT tokens, mostly useful for browser applications.", ["jwt", "browser"], 5_000_000, "MIT", "2023-11-10"],
  ["express-jwt", "JWT authentication middleware.", ["auth", "authn", "authentication", "authz", "authorization", "http", "jwt", "token", "oauth", "express"], 1_000_000, "MIT", "2023-06-01"],
  ["jws", "Implementation of JSON Web Signatures", ["jws", "json", "web", "signatures"], 20_000_000, "MIT", "2024-06-01"],
  ["@types/jsonwebtoken", "TypeScript definitions for jsonwebtoken", [], 5_000_000, "MIT", "2025-03-01"],
  // Markdown.
  ["marked", "A markdown parser built for speed", ["markdown", "markup", "html"], 15_000_000, "MIT", "2025-09-01"],
  ["markdown-it", "Markdown-it - modern pluggable markdown parser.", ["markdown", "parser", "commonmark", "markdown-it", "markdown-it-plugin"], 10_000_000, "MIT", "2025-01-01"],
  ["remark", "Markdown processor powered by plugins part of the unified collective", ["unified", "remark", "markdown", "mdast", "abstract", "syntax", "tree", "ast", "parse", "stringify", "serialize", "compile", "process"], 3_000_000, "MIT", "2024-09-01"],
  ["showdown", "A Markdown to HTML converter written in Javascript", ["markdown", "converter"], 1_000_000, "MIT", "2023-03-01"],
  ["react-markdown", "React component to render markdown", ["remark", "unified", "markdown", "commonmark", "gfm", "ast", "react", "react-component", "component"], 5_000_000, "MIT", "2025-03-01"],
  ["turndown", "A library that converts HTML to Markdown", ["converter", "html", "markdown"], 1_500_000, "MIT", "2025-01-01"],
  // Watching files.
  ["chokidar", "Minimal and efficient cross-platform file watching library", ["fs", "watch", "watchFile", "watcher", "watching", "file", "fsevents"], 60_000_000, "MIT", "2025-02-01"],
  ["watchpack", "", [], 25_000_000, "MIT", "2024-11-01"],
  ["nodemon", "Simple monitor script for use during development of a Node.js app.", ["cli", "monitor", "monitor", "development", "restart", "autoload", "reload", "terminal"], 7_000_000, "MIT", "2025-06-01"],
  ["node-watch", "A wrapper and enhancements for fs.watch", ["fs.watch", "watch", "watchfile"], 400_000, "MIT", "2023-06-01"],
  ["gaze", "A globbing fs.watch wrapper built from the best parts of other fine watch libs.", ["watch", "watcher", "watching", "fs.watch", "fswatcher", "fs", "glob", "utility"], 1_000_000, "MIT", "2016-06-01"],
  ["@parcel/watcher", "A native C++ Node module for querying and subscribing to filesystem events. Used by Parcel 2.", [], 10_000_000, "MIT", "2025-01-01"],
  // HTTP.
  ["axios", "Promise based HTTP client for the browser and node.js", ["xhr", "http", "ajax", "promise", "node"], 70_000_000, "MIT", "2025-09-01"],
  ["got", "Human-friendly and powerful HTTP request library for Node.js", ["http", "https", "http2", "get", "got", "url", "uri", "request", "simple", "curl", "wget", "fetch", "net", "network", "gzip", "brotli", "requests", "human-friendly", "axios", "superagent", "node-fetch", "ky"], 25_000_000, "MIT", "2025-06-01"],
  ["undici", "An HTTP/1.1 client, written from scratch for Node.js", ["fetch", "http", "https", "promise", "request", "curl", "wget", "xhr", "whatwg"], 30_000_000, "MIT", "2025-09-01"],
  ["node-fetch", "A light-weight module that brings Fetch API to node.js", ["fetch", "http", "promise", "request", "curl", "wget", "xhr", "whatwg"], 70_000_000, "MIT", "2023-08-12"],
  ["ky", "Tiny and elegant HTTP client based on the Fetch API", ["fetch", "request", "requests", "http", "https", "fetching", "get", "url", "curl", "wget", "net", "network", "ajax", "api", "rest", "xhr", "browser", "got", "axios", "node-fetch"], 3_000_000, "MIT", "2025-05-01"],
  ["request", "Simplified HTTP request client.", ["http", "simple", "util", "utility"], 15_000_000, "Apache-2.0", "2020-02-11"],
  ["superagent", "elegant & feature rich browser / node HTTP with a fluent API", ["agent", "ajax", "ajax", "api", "async", "await", "axios", "cancel", "client", "request", "requests", "http", "https"], 10_000_000, "MIT", "2025-01-01"],
  ["make-fetch-happen", "Opinionated, caching, retrying fetch client", ["http", "request", "fetch", "mean girls", "caching", "cache", "subresource integrity"], 20_000_000, "ISC", "2025-03-01"],
  // Retrying.
  ["p-retry", "Retry a promise-returning or async function", ["promise", "retry", "retries", "operation", "failed", "rejected", "try", "exponential", "backoff", "attempt", "async", "await", "promises", "concurrently", "concurrency", "parallel", "bluebird"], 20_000_000, "MIT", "2025-04-01"],
  ["async-retry", "Retrying made simple, easy and async", [], 5_000_000, "MIT", "2021-08-01"],
  ["retry", "Abstraction for exponential and custom retry strategies for failed operations.", [], 30_000_000, "MIT", "2020-12-01"],
  ["exponential-backoff", "A utility that allows retrying a function with an exponential delay between attempts.", ["exponential", "backoff", "retry"], 5_000_000, "Apache-2.0", "2024-09-01"],
  ["axios-retry", "Axios plugin that intercepts failed requests and retries them whenever posible.", ["axios", "retry", "retries", "exponential", "backoff"], 3_000_000, "Apache-2.0", "2025-03-01"],
  ["promise-retry", "Retries a function that returns a promise, leveraging the power of the retry module.", ["retry", "promise", "backoff", "repeat", "replay"], 20_000_000, "MIT", "2019-05-01"],
  ["backoff", "Fibonacci and exponential backoffs.", ["backoff", "retry", "fibonacci", "exponential"], 2_000_000, "MIT", "2014-05-01"],
  // Terminal colours.
  ["chalk", "Terminal string styling done right", ["color", "colour", "colors", "terminal", "console", "cli", "string", "ansi", "style", "styles", "tty", "formatting", "rgb", "256", "shell", "xterm", "log", "logging", "command-line", "text"], 300_000_000, "MIT", "2025-08-01"],
  ["picocolors", "The tiniest and the fastest library for terminal output formatting with ANSI colors", ["terminal", "colors", "formatting", "cli", "console"], 100_000_000, "ISC", "2024-10-01"],
  ["kleur", "The fastest Node.js library for formatting terminal text with ANSI colors~!", ["ansi", "cli", "color", "colors", "console", "terminal"], 30_000_000, "MIT", "2022-06-01"],
  ["colorette", "🌈Easily set your terminal text color & styles.", ["terminal", "styles", "color", "ansi"], 30_000_000, "MIT", "2023-06-01"],
  ["colors", "get colors in your node.js console", ["ansi", "terminal", "colors"], 20_000_000, "MIT", "2022-01-08"],
  ["ansi-colors", "Easily add ANSI colors to your text and symbols in the terminal.", ["ansi", "bgblack", "bgBlack", "bgblue", "color", "colors", "terminal"], 50_000_000, "MIT", "2022-06-01"],
  ["cli-color", "Colors, formatting and other tools for the console", ["ansi", "color", "console", "terminal", "cli", "shell", "log", "logging", "xterm"], 5_000_000, "ISC", "2024-06-01"],
  // YAML.
  ["yaml", "JavaScript parser and stringifier for YAML", ["YAML", "parser", "stringifier"], 60_000_000, "ISC", "2025-08-01"],
  ["js-yaml", "YAML 1.2 parser and serializer", ["yaml", "parser", "serializer", "pyyaml"], 100_000_000, "MIT", "2025-08-15"],
  ["yamljs", "Standalone JavaScript YAML 1.2 Parser & Encoder. Works under node.js and all major browsers. Also brings command line YAML/JSON conversion tools.", ["yaml"], 1_000_000, "MIT", "2018-05-01"],
  ["@types/js-yaml", "TypeScript definitions for js-yaml", [], 10_000_000, "MIT", "2024-06-01"],
  ["front-matter", "Extract YAML front matter from a string", ["yaml", "front matter", "meta"], 2_000_000, "MIT", "2021-06-01"],
  ["gray-matter", "Parse front-matter from a string or file. Fast, reliable and easy to use. Parses YAML front matter by default, but also has support for YAML, JSON, TOML or Coffee Front-Matter, with options to set custom delimiters. Used by metalsmith, assemble, verb and many other projects.", ["front-matter", "yaml", "toml", "parse", "parser"], 3_000_000, "MIT", "2021-06-01"],
  // Images.
  ["sharp", "High performance Node.js image processing, the fastest module to resize JPEG, PNG, WebP, GIF, AVIF and TIFF images", ["jpeg", "png", "webp", "avif", "tiff", "gif", "svg", "jp2", "dzi", "image", "resize", "thumbnail", "crop", "embed", "libvips", "vips"], 15_000_000, "Apache-2.0", "2025-08-01"],
  ["jimp", "An image processing library written entirely in JavaScript.", ["image", "image processing", "image manipulation", "png", "jpg", "jpeg", "bmp", "resize", "scale", "crop"], 2_000_000, "MIT", "2025-02-01"],
  ["image-size", "get dimensions of any image file", ["image", "size", "dimensions", "resolution", "width", "height"], 15_000_000, "MIT", "2025-04-01"],
  ["browser-image-compression", "Compress images in the browser", ["image", "compression", "compress", "jpg", "jpeg", "png", "resize"], 500_000, "MIT", "2024-02-01"],
  ["gm", "GraphicsMagick and ImageMagick for node.js", ["graphics", "magick", "image", "graphicsmagick", "imagemagick", "gm", "convert", "thumbnail", "resize"], 500_000, "MIT", "2022-11-01"],
  ["imagemin", "Minify images seamlessly", ["minify", "compress", "image", "images", "jpeg", "jpg", "png", "gif", "svg"], 1_000_000, "MIT", "2021-06-01"],
  // PDF.
  ["pdfkit", "A PDF generation library for Node.js", ["pdf", "pdf writer", "pdf generator", "graphics", "document", "vector"], 1_000_000, "MIT", "2025-04-01"],
  ["pdf-lib", "Create and modify PDF files with JavaScript", ["pdf", "pdf-lib", "document", "create", "modify", "creation", "modification", "edit", "editing", "typescript", "javascript", "library"], 2_000_000, "MIT", "2021-11-06"],
  ["jspdf", "PDF Document creation from JavaScript", ["pdf"], 5_000_000, "MIT", "2025-08-01"],
  ["pdfmake", "Client/server side PDF printing in pure JavaScript", ["pdf", "javascript", "printing", "layout"], 1_000_000, "MIT", "2025-06-01"],
  ["pdf-parse", "Pure javascript cross-platform module to extract texts from PDFs.", ["pdf-parse", "pdf-crawler", "xpdf", "pdf.js", "pdfreader", "pdf-extractor", "pdf2json", "j-pdfjson", "pdf-parser", "pdf-extract", "pdf-extraction", "pdf-to-text"], 1_000_000, "MIT", "2025-01-01"],
  ["pdfjs-dist", "Generic build of Mozilla's PDF.js library.", ["Mozilla", "pdf", "pdf.js"], 5_000_000, "Apache-2.0", "2025-08-01"],
  ["html-pdf", "HTML to PDF converter that uses phantomjs", ["html", "pdf", "phantom", "phantomjs", "nodejs", "converter"], 100_000, "MIT", "2021-06-01"],
  // Rate limiting.
  ["express-rate-limit", "Basic IP rate-limiting middleware for Express. Use to limit repeated requests to public APIs and/or endpoints such as password reset.", ["express-rate-limit", "express", "rate", "limit", "ratelimit", "rate-limit", "middleware", "ip", "auth", "authorization", "security", "brute", "force", "bruteforce", "brute-force", "attack"], 10_000_000, "MIT", "2025-06-01"],
  ["rate-limiter-flexible", "Node.js rate limiter by key and protection from DDoS and Brute-Force attacks in process Memory, Redis, MongoDb, Memcached, MySQL, PostgreSQL, Cluster or PM", ["ratelimter", "authorization", "security", "rate", "limit", "bruteforce", "throttle", "redis", "mongodb", "dynamodb", "mysql", "postgres", "prisma", "koa", "express", "hapi", "valkey", "valkey-glide", "GLIDE"], 2_000_000, "ISC", "2025-07-01"],
  ["bottleneck", "Distributed task scheduler and rate limiter", ["async rate limiter", "rate limiter", "rate limiting", "async", "rate", "limiting", "limiter", "throttle", "throttling", "throttler", "load", "clustering"], 5_000_000, "MIT", "2019-12-01"],
  ["p-limit", "Run multiple promise-returning & async functions with limited concurrency", ["promise", "limit", "limited", "concurrency", "throttle", "throat", "rate", "batch", "ratelimit", "task", "queue", "async", "await", "promises", "bluebird"], 150_000_000, "MIT", "2025-02-01"],
  ["limiter", "A generic rate limiter for the web and node.js. Useful for API clients, web crawling, or other tasks that need to be throttled", ["rate", "limiting", "throttling"], 3_000_000, "MIT", "2021-06-01"],
  ["@nestjs/throttler", "A Rate-Limiting module for NestJS to work on Express, Fastify, Websockets, Socket.IO, and GraphQL, all rolled up into a simple package.", [], 1_000_000, "MIT", "2025-05-01"],
  ["p-throttle", "Throttle promise-returning & async functions", ["promise", "throttle", "throat", "limit", "limited", "interval", "rate", "batch", "ratelimit", "queue", "time", "async", "await", "promises", "bluebird"], 1_000_000, "MIT", "2025-02-01"],
  // Glob matching.
  ["glob", "the most correct and second fastest glob implementation in JavaScript", [], 200_000_000, "ISC", "2025-07-01"],
  ["fast-glob", "It's a very fast and efficient glob library for Node.js", ["glob", "patterns", "fast", "implementation"], 80_000_000, "MIT", "2025-01-01"],
  ["globby", "User-friendly glob matching", ["all", "array", "directories", "expand", "files", "filesystem", "filter", "find", "fnmatch", "folders", "fs", "glob", "globbing", "globs", "gulpfriendly", "match", "matcher", "minimatch", "multi", "multiple", "paths", "pattern", "patterns", "traverse", "util", "utility", "wildcard", "wildcards", "promise", "gitignore", "git"], 60_000_000, "MIT", "2025-03-01"],
  ["minimatch", "a glob matcher in javascript", [], 250_000_000, "ISC", "2025-08-01"],
  ["picomatch", "Blazing fast and accurate glob matcher written in JavaScript, with no dependencies and full support for standard and extended Bash glob features, including braces, extglobs, POSIX brackets, and regular expressions.", ["glob", "match", "picomatch"], 200_000_000, "MIT", "2025-04-01"],
  ["micromatch", "Glob matching for javascript/node.js. A replacement and faster alternative to minimatch and multimatch.", ["bash", "bracket", "character-class", "expand", "expansion", "expression", "extglob", "extglobs", "file", "files", "filter", "find", "glob", "globbing", "globs", "globstar", "lookahead", "lookaround", "lookbehind", "match", "matcher", "matches", "matching", "micromatch", "minimatch", "multimatch", "negate", "negation", "path", "pattern", "patterns", "posix", "regex", "regexp", "regular", "shell", "wildcard"], 80_000_000, "MIT", "2024-08-01"],
  ["is-glob", "Returns `true` if the given string looks like a glob pattern or an extglob pattern. This makes it easy to create code that only uses external modules like node-glob when necessary, resulting in much faster code execution and initialization time, and a better user experience.", ["bash", "braces", "check", "exec", "expression", "extglob", "glob", "globbing", "globstar", "is", "match", "matches", "pattern", "regex", "regular", "string", "test"], 100_000_000, "MIT", "2021-06-01"],
  ["glob-parent", "Extract the non-magic parent path from a glob string.", ["glob", "parent", "strip", "path", "dirname", "directory", "base", "wildcard"], 100_000_000, "ISC", "2021-06-01"],
  ["path-to-regexp", "Express style path to RegExp utility", ["express", "regexp", "route", "routing"], 80_000_000, "MIT", "2025-03-01"],
  // Cron.
  ["node-cron", "A simple cron-like task scheduler for Node.js", ["cron", "scheduler", "schedule", "task", "job"], 3_000_000, "ISC", "2025-05-01"],
  ["cron", "Cron jobs for your node", ["cron", "node cron", "node-cron", "schedule", "scheduler", "cronjob", "cron job"], 3_000_000, "MIT", "2025-07-01"],
  ["croner", "Trigger functions and/or evaluate cron expressions in JavaScript. No dependencies. Most features. All environments.", ["cron", "front-end", "backend", "parser", "croner", "schedule", "scheduler", "timer", "task", "job", "isomorphic", "typescript"], 3_000_000, "MIT", "2025-06-01"],
  ["node-schedule", "A cron-like and not-cron-like job scheduler for Node.", ["schedule", "task", "job", "cron", "recurrent", "in-memory"], 2_000_000, "MIT", "2023-01-01"],
  ["cron-parser", "Node.js library for parsing crontab instructions", ["cron", "crontab", "parser"], 5_000_000, "MIT", "2025-04-01"],
  ["agenda", "Light weight job scheduler for Node.js", ["job", "jobs", "cron", "delayed", "scheduler", "runner"], 200_000, "MIT", "2023-06-01"],
  ["@nestjs/schedule", "Nest - modern, fast, powerful node.js web framework (@schedule)", [], 1_000_000, "MIT", "2025-05-01"],
  // Versions.
  ["semver", "The semantic version parser used by npm.", [], 300_000_000, "ISC", "2025-09-01"],
  ["compare-versions", "Compare semver version strings to find greater, equal or lesser.", ["semver", "version", "versions", "compare", "browser"], 5_000_000, "MIT", "2024-09-01"],
  ["semver-compare", "compare two semver version strings, returning -1, 0, or 1", ["semver", "compare", "cmp", "comparison", "sort"], 5_000_000, "MIT", "2015-06-01"],
  ["@types/semver", "TypeScript definitions for semver", [], 30_000_000, "MIT", "2025-02-01"],
  ["semver-regex", "Regular expression for matching semver versions", ["semver", "version", "versioning", "regex", "regexp", "match", "matching", "semantic"], 2_000_000, "MIT", "2023-06-01"],
  // WebSockets.
  ["ws", "Simple to use, blazing fast and thoroughly tested websocket client and server for Node.js", ["HyBi", "Push", "RFC-6455", "WebSocket", "WebSockets", "real-time"], 100_000_000, "MIT", "2025-08-01"],
  ["socket.io", "node.js realtime framework server", ["realtime", "framework", "websocket", "tcp", "events", "socket", "io"], 7_000_000, "MIT", "2025-06-01"],
  ["websocket", "Websocket Client & Server Library implementing the WebSocket protocol as specified in RFC 6455.", ["websocket", "websockets", "socket", "networking", "comet", "push", "RFC-6455", "realtime", "server", "client"], 1_000_000, "Apache-2.0", "2024-05-01"],
  ["sockjs", "SockJS-node is a server counterpart of SockJS-client a JavaScript library that provides a WebSocket-like object in the browser.", ["websockets", "websocket"], 5_000_000, "MIT", "2021-06-01"],
  ["@fastify/websocket", "basic websocket support for fastify", ["fastify", "websocket"], 400_000, "MIT", "2025-04-01"],
  ["isomorphic-ws", "Isomorphic implementation of WebSocket", ["isomorphic", "websocket", "ws", "browser", "node"], 10_000_000, "MIT", "2022-06-01"],
  // PostgreSQL.
  ["pg", "PostgreSQL client - pure javascript & libpq with the same API", ["database", "libpq", "pg", "postgre", "postgres", "postgresql", "rdbms"], 10_000_000, "MIT", "2025-08-01"],
  ["postgres", "Fastest full featured PostgreSQL client for Node.js", ["driver", "postgres", "postgre", "postgresql", "client", "sql", "db", "pg", "database"], 2_000_000, "Unlicense", "2025-03-01"],
  ["knex", "A batteries-included SQL query & schema builder for PostgresSQL, MySQL, CockroachDB, MSSQL and SQLite3", ["sql", "query", "postgresql", "mysql", "cockroachdb", "sqlite3", "oracle", "mssql"], 2_000_000, "MIT", "2025-01-01"],
  ["kysely", "Type safe SQL query builder", ["query", "builder", "sql", "typescript", "database", "postgres", "postgresql", "mysql", "sqlite", "orm"], 1_500_000, "MIT", "2025-07-01"],
  ["drizzle-orm", "Drizzle ORM package for SQL databases", ["drizzle", "orm", "pg", "mysql", "postgresql", "postgres", "sqlite", "database", "sql", "typescript", "ts", "drizzle-orm"], 2_000_000, "Apache-2.0", "2025-09-01"],
  ["prisma", "Prisma is an open-source database toolkit. It includes a JavaScript/TypeScript ORM for Node.js, migrations and a modern GUI to view and edit the data in your database. You can use Prisma in new projects or add it to an existing one.", ["ORM", "Prisma", "prisma2", "Prisma Client", "Prisma Migrate", "Prisma Studio", "migrations", "database", "SQL", "query builder", "mysql", "postgresql", "sqlite", "mongodb"], 3_000_000, "Apache-2.0", "2025-09-01"],
  ["pg-promise", "PostgreSQL interface for Node.js", ["pg", "promise", "postgres"], 500_000, "MIT", "2025-06-01"],
  ["sequelize", "Sequelize is a promise-based Node.js ORM tool for Postgres, MySQL, MariaDB, SQLite, Microsoft SQL Server, Amazon Redshift and Snowflake’s Data Cloud. It features solid transaction support, relations, eager and lazy loading, read replication and more.", ["mysql", "mariadb", "sqlite", "postgresql", "postgres", "pg", "mssql", "db2", "ibm_db", "sql", "sqlserver", "snowflake", "orm", "nodejs", "object relational mapper", "database", "db"], 2_000_000, "MIT", "2025-02-01"],
  ["@types/pg", "TypeScript definitions for pg", [], 5_000_000, "MIT", "2025-06-01"],
  ["pg-pool", "Connection pool for node-postgres", ["pg", "postgres", "pool", "database"], 8_000_000, "MIT", "2025-08-01"],
  // Noise a searched none-need can meet: small, unrelated or unused.
  ["refund-calc", "Calculate a refund for a returned order", ["refund", "order"], 12, "MIT", "2024-02-01"],
  ["loyalty-points", "Track loyalty points for customers", ["loyalty", "points"], 40, "MIT", "2023-03-01"],
  ["username", "Get the username of the current user", ["username", "user", "name", "whoami", "login"], 1_000_000, "MIT", "2021-06-01"],
  ["greeting-time", "Greet the user with a greeting for the time of day", ["greeting", "greet", "time"], 300, "MIT", "2020-06-01"],
  ["stripe", "Stripe API wrapper", ["stripe", "payment processing", "credit cards", "api"], 4_000_000, "MIT", "2025-09-01"],
];

type Repo = [
  fullName: string,
  description: string,
  topics: string[],
  stars: number,
  license: string,
  pushedAt: string,
  /** The PyPI project whose links name this repository, when there is one. */
  pypi?: string,
];

// biome-ignore format: a corpus, one package per line
const GITHUB: Repo[] = [
  ["psf/requests", "A simple, yet elegant, HTTP library.", ["python", "http", "requests", "client", "http-client", "python-requests", "forhumans", "cookies", "humans"], 53_000, "Apache-2.0", "2025-09-01", "requests"],
  ["encode/httpx", "A next generation HTTP client for Python. 🦋", ["python", "http", "asyncio", "trio", "http-client"], 14_000, "BSD-3-Clause", "2025-08-01", "httpx"],
  ["aio-libs/aiohttp", "Asynchronous HTTP client/server framework for asyncio and Python", ["python", "http", "asyncio", "aiohttp", "http-client", "http-server"], 15_000, "Apache-2.0", "2025-09-01", "aiohttp"],
  ["urllib3/urllib3", "urllib3 is a user-friendly HTTP client library for Python", ["python", "http", "http-client", "urllib3"], 4_000, "MIT", "2025-09-01", "urllib3"],
  ["httpie/cli", "🥧 HTTPie CLI — modern, user-friendly command-line HTTP client for the API era. JSON support, colors, sessions, downloads, plugins & more.", ["python", "cli", "http", "json", "api", "http-client", "terminal"], 35_000, "BSD-3-Clause", "2025-06-01"],
  ["yaml/pyyaml", "Canonical source repository for PyYAML", ["python", "yaml", "pyyaml", "libyaml"], 2_600, "MIT", "2025-08-01", "PyYAML"],
  ["pydantic/pydantic", "Data validation using Python type hints", ["python", "json", "validation", "parsing", "json-schema", "hints", "pydantic"], 23_000, "MIT", "2025-09-01", "pydantic"],
  ["marshmallow-code/marshmallow", "A lightweight library for converting complex objects to and from simple Python datatypes.", ["python", "serialization", "deserialization", "validation", "schema", "marshalling"], 7_000, "MIT", "2025-08-01", "marshmallow"],
  ["python-attrs/attrs", "Python Classes Without Boilerplate", ["python", "classes", "oop", "boilerplate", "attributes"], 5_500, "MIT", "2025-08-01", "attrs"],
  ["lxml/lxml", "The lxml XML toolkit for Python", ["python", "xml", "html", "xpath", "xslt", "libxml2"], 2_800, "BSD-3-Clause", "2025-08-01", "lxml"],
  ["rushter/selectolax", "Python binding to Modest and Lexbor engines (fast HTML5 parser with CSS selectors).", ["python", "html", "parser", "html-parser", "css-selectors"], 1_300, "MIT", "2025-06-01", "selectolax"],
  ["scrapy/parsel", "Parsel lets you extract data from XML/HTML documents using XPath or CSS selectors", ["python", "html", "xml", "xpath", "css-selectors", "scraping"], 1_200, "BSD-3-Clause", "2025-05-01", "parsel"],
  ["jmcnamara/XlsxWriter", "A Python module for creating Excel XLSX files.", ["python", "excel", "xlsx", "spreadsheet"], 3_700, "BSD-2-Clause", "2025-08-01", "XlsxWriter"],
  ["pandas-dev/pandas", "Flexible and powerful data analysis / manipulation library for Python, providing labeled data structures similar to R data.frame objects, statistical functions, and much more", ["python", "data-science", "pandas", "dataframe", "data-analysis", "excel"], 45_000, "BSD-3-Clause", "2025-09-01", "pandas"],
  ["py-pdf/fpdf2", "Simple PDF generation for Python", ["python", "pdf", "pdf-generation", "library"], 1_300, "LGPL-3.0-only", "2025-08-01", "fpdf2"],
  ["Kozea/WeasyPrint", "The awesome document factory", ["python", "pdf", "html", "css", "pdf-generation"], 7_500, "BSD-3-Clause", "2025-08-01", "weasyprint"],
  ["python-pillow/Pillow", "Python Imaging Library (Fork)", ["python", "image", "image-processing", "pillow", "pil", "resize"], 12_500, "MIT-CMU", "2025-09-01", "pillow"],
  ["pyca/bcrypt", "Modern(-ish) password hashing for your software and your servers", ["python", "bcrypt", "password", "hashing"], 1_300, "Apache-2.0", "2025-08-01", "bcrypt"],
  ["hynek/argon2-cffi", "Secure Password Hashes for Python", ["python", "argon2", "password", "hashing", "security"], 600, "MIT", "2025-06-01", "argon2-cffi"],
  ["dateutil/dateutil", "Useful extensions to the standard Python datetime features", ["python", "datetime", "dateutil", "timezone"], 2_500, "Apache-2.0", "2025-03-01", "python-dateutil"],
  ["arrow-py/arrow", "🏹 Better dates & times for Python", ["python", "date", "time", "datetime", "timezone", "arrow"], 8_800, "Apache-2.0", "2025-06-01", "arrow"],
  ["sdispater/pendulum", "Python datetimes made easy", ["python", "datetime", "date", "time", "timezone"], 6_400, "MIT", "2025-04-01", "pendulum"],
  ["jd/tenacity", "Retrying library for Python", ["python", "retry", "retrying", "backoff"], 7_000, "Apache-2.0", "2025-06-01", "tenacity"],
  ["litl/backoff", "Python library providing function decorators for configurable backoff and retry", ["python", "backoff", "retry", "decorators"], 2_600, "MIT", "2024-10-01", "backoff"],
  ["Textualize/rich", "Rich is a Python library for rich text and beautiful formatting in the terminal.", ["python", "terminal", "rich", "syntax-highlighting", "tables", "progress-bar", "markdown", "ansi-colors"], 50_000, "MIT", "2025-09-01", "rich"],
  ["tartley/colorama", "Simple cross-platform colored terminal text in Python", ["python", "terminal", "color", "ansi", "windows"], 3_600, "BSD-3-Clause", "2025-02-01", "colorama"],
  ["termcolor/termcolor", "ANSI color formatting for output in terminal", ["python", "terminal", "color", "ansi"], 800, "MIT", "2025-04-01", "termcolor"],
  ["jpadilla/pyjwt", "JSON Web Token implementation in Python", ["python", "jwt", "json-web-token", "authentication"], 5_200, "MIT", "2025-08-01", "PyJWT"],
  ["mpdavis/python-jose", "A JOSE implementation in Python", ["python", "jose", "jwt", "jws", "jwe", "jwk"], 1_600, "MIT", "2025-05-01", "python-jose"],
  ["authlib/authlib", "The ultimate Python library in building OAuth, OpenID Connect clients and servers. JWS,JWE,JWK,JWA,JWT included.", ["python", "oauth", "oauth2", "openid", "jwt", "jose"], 4_800, "BSD-3-Clause", "2025-08-01", "Authlib"],
  // Unrelated projects the searches can meet.
  ["public-apis/public-apis", "A collective list of free APIs", ["api", "apis", "list", "resources", "free", "public-apis"], 300_000, "MIT", "2025-09-01"],
  ["donnemartin/system-design-primer", "Learn how to design large-scale systems. Prep for the system design interview. Includes Anki flashcards.", ["python", "design", "system", "interview"], 280_000, "NOASSERTION", "2025-06-01"],
  ["TheAlgorithms/Python", "All Algorithms implemented in Python", ["python", "algorithms", "sorting", "searching", "hashes", "prime"], 190_000, "MIT", "2025-09-01"],
];

const npmUrl = (name: string) => `https://www.npmjs.com/package/${name}`;

/** A query word matches itself, its plural and its "-es" form, as a substring. */
function wordMatches(word: string, text: string): boolean {
  const w = word.toLowerCase();
  const bare = w.replace(/(?:es|s)$/, "");
  return text.includes(w) || (bare.length >= 3 && text.includes(bare));
}

function npmSearch(text: string, size: number) {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  return NPM.map((p) => {
    const hay = `${p[0]} ${p[1]} ${p[2].join(" ")}`.toLowerCase();
    return { p, n: words.filter((w) => wordMatches(w, hay)).length };
  })
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || b.p[3] - a.p[3])
    .slice(0, size)
    .map(({ p: [name, description, keywords, weekly, license, date] }) => ({
      package: {
        name,
        version: "1.0.0",
        description,
        keywords,
        license,
        date,
        links: { npm: npmUrl(name) },
      },
      downloads: { weekly, monthly: weekly * 4 },
    }));
}

function githubSearch(q: string, perPage: number) {
  const words = q
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w && !w.startsWith("language:"));
  const language = /language:(\w+)/.exec(q)?.[1];
  return GITHUB.filter((r) => {
    const hay = `${r[0]} ${r[1]} ${r[2].join(" ")}`.toLowerCase();
    return (!language || r[2].includes(language)) && words.every((w) => wordMatches(w, hay));
  })
    .sort((a, b) => b[3] - a[3])
    .slice(0, perPage)
    .map(([full_name, description, topics, stars, license, pushed_at]) => ({
      full_name,
      description,
      topics,
      stargazers_count: stars,
      license: { spdx_id: license },
      archived: false,
      pushed_at,
      html_url: `https://github.com/${full_name}`,
    }));
}

const pep503 = (n: string) => n.toLowerCase().replace(/[-_.]+/g, "-");

/** Every URL the survey sends, answered from the corpus; anything else is an empty 200. */
export function registryFixture() {
  const urls: string[] = [];
  const fetchImpl = async (input: string | URL): Promise<Response> => {
    const url = new URL(String(input));
    urls.push(url.toString());
    if (url.hostname === "registry.npmjs.org" && url.pathname === "/-/v1/search") {
      const size = Number(url.searchParams.get("size") ?? "20");
      return Response.json({ objects: npmSearch(url.searchParams.get("text") ?? "", size) });
    }
    if (url.hostname === "api.github.com" && url.pathname === "/search/repositories") {
      const per = Number(url.searchParams.get("per_page") ?? "30");
      const items = githubSearch(url.searchParams.get("q") ?? "", per);
      return Response.json({ total_count: items.length, items });
    }
    const pypi = /^\/pypi\/([^/]+)\/json$/.exec(url.pathname);
    if (url.hostname === "pypi.org" && pypi) {
      const name = pep503(decodeURIComponent(pypi[1] ?? ""));
      const r = GITHUB.find((x) => x[6] && pep503(x[6]) === name);
      if (!r || !r[6]) return new Response("not found", { status: 404 });
      return Response.json({
        info: {
          name: r[6],
          version: "1.0.0",
          license_expression: r[4],
          summary: r[1],
          project_urls: { Source: `https://github.com/${r[0]}` },
        },
        urls: [{ upload_time_iso_8601: `${r[5]}T00:00:00Z` }],
      });
    }
    const dd = /^\/v3\/systems\/(npm|pypi)\/packages\/([^/]+)\/versions\/([^/]+)$/.exec(
      url.pathname,
    );
    if (url.hostname === "api.deps.dev" && dd) {
      const name = decodeURIComponent(dd[2] ?? "");
      const npm = NPM.find((p) => p[0] === name);
      const repo = GITHUB.find((r) => r[6] && pep503(r[6]) === pep503(name));
      const found =
        dd[1] === "npm"
          ? npm && { license: npm[4], date: npm[5] }
          : repo && { license: repo[4], date: repo[5] };
      if (!found) return new Response("not found", { status: 404 });
      return Response.json({
        versionKey: { system: dd[1]?.toUpperCase(), name, version: dd[3] },
        publishedAt: `${found.date}T00:00:00Z`,
        isDefault: true,
        licenses: [found.license],
        advisoryKeys: [],
      });
    }
    return new Response("[]", { status: 200 });
  };
  return { fetchImpl, urls };
}
