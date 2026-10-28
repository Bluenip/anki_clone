// pages.dev uses a different anycast address pool from this site's slow route.
// Keep authentication, CORS, streaming and observability in the bound Worker.
export default {
  fetch(request, env) {
    return env.UPLOAD_RELAY.fetch(request);
  },
};
