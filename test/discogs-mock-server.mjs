import http from "node:http";

// Minimal in-memory Discogs API used by the tests, with a configurable collection.
export class DiscogsMockServer {
  // Configures the fake collection size, the items-per-page chunk and tracking flags.
  constructor({ total = 120, chunk = 50 } = {}) {
    this.total = total;
    this.chunk = chunk;
    this.stale = false;
    this.collectionRequests = [];
    this._server = null;
    this._base = null;
  }

  // Base URL of the running mock server.
  get url() {
    return this._base;
  }

  // Starts the HTTP server on an ephemeral port.
  async start() {
    this._server = http.createServer((req, res) => this._route(req, res));
    await new Promise((resolve) => this._server.listen(0, resolve));
    this._base = `http://localhost:${this._server.address().port}`;
    return this._base;
  }

  // Stops the server and closes the listener.
  async stop() {
    if (!this._server) return;
    const server = this._server;
    this._server = null;
    await new Promise((resolve) => server.close(resolve));
  }

  // Fabricates a collection item, with no master_url for every 4th item.
  item(i) {
    return {
      id: i,
      instance_id: 1000 + i,
      date_added: "2026-01-01",
      rating: 0,
      basic_information: {
        id: i,
        title: `Album ${i}`,
        year: 2000 + (i % 25),
        resource_url: `${this.url}/releases/${i}`,
        master_url: i % 4 === 0 ? null : `${this.url}/masters/${i}`,
        artists: [{ name: `Artist ${i}` }],
      },
    };
  }

  // Returns the items for the given page, as the Discogs pagination would.
  pageReleases(page) {
    const start = (page - 1) * this.chunk;
    const count = Math.min(this.chunk, this.total - start);
    return Array.from({ length: count }, (_, k) => this.item(start + k));
  }

  // Serves the collection, masters and releases endpoints; everything else is a 404.
  _route(req, res) {
    const url = new URL(req.url, "http://localhost");
    res.setHeader("content-type", "application/json");
    const page = parseInt(url.searchParams.get("page") ?? "1", 10);

    if (url.pathname.includes("/collection/folders/0/releases")) {
      this.collectionRequests.push(page);
      const served = this.stale && page > 1 ? this.pageReleases(1) : this.pageReleases(page);
      const body = {
        pagination: {
          page,
          pages: Math.ceil(this.total / this.chunk),
          items: this.total,
          per_page: this.chunk,
        },
        releases: served,
      };
      res.end(JSON.stringify(body));
      return;
    }

    let m = url.pathname.match(/^\/masters\/(\d+)$/);
    if (m) {
      const id = Number(m[1]);
      res.end(JSON.stringify({ id, main_release_url: `${this.url}/releases/${id}` }));
      return;
    }

    m = url.pathname.match(/^\/releases\/(\d+)$/);
    if (m) {
      const id = Number(m[1]);
      res.end(
        JSON.stringify({
          id,
          artists_sort: `SortArtist ${id}`,
          title: `ResolvedTitle ${id}`,
          released: `201${id % 10}`,
        })
      );
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ message: "not found" }));
  }
}