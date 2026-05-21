module.exports = {
  require: [require.resolve('@qa-debug/mocha-hooks/register')],
  reporter: require.resolve('@qa-debug/mocha-hooks/qa-reporter'),
  spec: ['specs/**/*.spec.js'],
  timeout: 10_000,
};

