const { expressjwt: jwt } = require('express-jwt');
const jwksRsa = require('jwks-rsa');

// Auth0 Configuration from environment variables
const authConfig = {
  domain: process.env.AUTH0_DOMAIN || "mindfuels.us.auth0.com",
  audience: process.env.AUTH0_AUDIENCE || "mindfuels-api"
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
