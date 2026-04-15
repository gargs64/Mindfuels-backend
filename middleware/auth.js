const { expressjwt: jwt } = require('express-jwt');
const jwksRsa = require('jwks-rsa');

// Auth0 Configuration from your Frontend (e.g., domain)
const authConfig = {
  domain: "dev-f2v3o6x7.us.auth0.com", // Found in your script.js
  audience: "https://dev-f2v3o6x7.us.auth0.com/userinfo" // Using standard userinfo as placeholder
};

const checkJwt = jwt({
  secret: jwksRsa.expressJwtSecret({
    cache: true,
    rateLimit: true,
    jwksRequestsPerMinute: 5,
    jwksUri: `https://${authConfig.domain}/.well-known/jwks.json`
  }),
  audience: authConfig.audience,
  issuer: `https://${authConfig.domain}/`,
  algorithms: ['RS256']
});

module.exports = checkJwt;
