module.exports = {
  fetchDependencies: require('./lib/online-fetcher').fetchDependencies,
  publishPackages: require('./lib/offline-publisher').publishPackages
};
