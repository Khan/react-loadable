"use strict";
const React = require("react");
const PropTypes = require("prop-types");

const ALL_INITIALIZERS = [];
const READY_INITIALIZERS = [];
const CONSTRUCTED_INITIALIZERS = [];
const CONSTRUCTED_RESULTS = [];

function isWebpackReady(moduleIds) {
  if (typeof __webpack_modules__ !== "object") {
    return false;
  }

  return moduleIds.every(moduleId => {
    return (
      typeof moduleId !== "undefined" &&
      typeof __webpack_modules__[moduleId] !== "undefined"
    );
  });
}

function load(loader) {
  let promise = loader();

  let state = {
    loading: true,
    loaded: null,
    error: null
  };

  state.promise = promise
    .then(loaded => {
      state.loading = false;
      state.loaded = loaded;
      return loaded;
    })
    .catch(err => {
      state.loading = false;
      state.error = err;
      throw err;
    });

  return state;
}

function loadMap(obj) {
  let state = {
    loading: false,
    loaded: {},
    error: null
  };

  let promises = [];

  try {
    Object.keys(obj).forEach(key => {
      let result = load(obj[key]);

      if (!result.loading) {
        state.loaded[key] = result.loaded;
        state.error = result.error;
      } else {
        state.loading = true;
      }

      promises.push(result.promise);

      result.promise
        .then(res => {
          state.loaded[key] = res;
        })
        .catch(err => {
          state.error = err;
        });
    });
  } catch (err) {
    state.error = err;
  }

  state.promise = Promise.all(promises)
    .then(res => {
      state.loading = false;
      return res;
    })
    .catch(err => {
      state.loading = false;
      throw err;
    });

  return state;
}

function resolve(obj) {
  return obj && obj.__esModule ? obj.default : obj;
}

function render(loaded, props) {
  return React.createElement(resolve(loaded), props);
}

function createLoadableComponent(loadFn, options) {
  if (!options.loading) {
    throw new Error("react-loadable requires a `loading` component");
  }

  let opts = Object.assign(
    {
      loader: null,
      loading: null,
      delay: 200,
      timeout: null,
      render: render,
      modules: null
    },
    options
  );

  let res = null;

  function init() {
    if (!res) {
      res = loadFn(opts.loader);
    }
    return res.promise;
  }

  ALL_INITIALIZERS.push(init);

  if (Array.isArray(opts.modules)) {
    READY_INITIALIZERS.push(() => {
      if (isWebpackReady(opts.modules)) {
        return init();
      }
    });
  }

  return class LoadableComponent extends React.Component {
    constructor(props) {
      super(props);
      init();
      CONSTRUCTED_INITIALIZERS.push(init);
      CONSTRUCTED_RESULTS.push(res);

      this.state = {
        error: res.error,
        pastDelay: false,
        timedOut: false,
        loading: res.loading,
        loaded: res.loaded
      };
    }

    static contextTypes = {
      loadable: PropTypes.shape({
        report: PropTypes.func.isRequired
      })
    };

    static preload() {
      return init();
    }

    UNSAFE_componentWillMount() {
      this._loadModule();
    }

    componentDidMount() {
      this._mounted = true;
    }

    componentWillUnmount() {
      this._mounted = false;
    }

    _loadModule() {
      if (!res.loading) {
        if (this.context.loadable && Array.isArray(opts.modules)) {
          opts.modules.forEach(moduleName => {
            this.context.loadable.report(moduleName);
          });
        }

        return;
      }

      if (typeof opts.delay === "number") {
        this._delay = setTimeout(() => {
          if (this._mounted) {
            this.setState({ pastDelay: true });
          }
        }, opts.delay);
      }

      if (typeof opts.timeout === "number") {
        this._timeout = setTimeout(() => {
          if (this._mounted) {
            this.setState({ timedOut: true });
          }
        }, opts.timeout);
      }

      let update = () => {
        if (!this._mounted) {
          return;
        }

        this.setState({
          error: res.error,
          loaded: res.loaded,
          loading: res.loading
        });

        this._clearTimeouts();
      };

      res.promise
        .then(() => {
          update();
        })
        .catch(err => {
          update();
        });
    }

    componentWillUnmount() {
      this._mounted = false;
      this._clearTimeouts();
    }

    _clearTimeouts() {
      clearTimeout(this._delay);
      clearTimeout(this._timeout);
    }

    retry = () => {
      if (!this._mounted) {
        return;
      }
      this.setState({ error: null, loading: true, timedOut: false });
      res = loadFn(opts.loader);
      this._loadModule();
    };

    render() {
      if (this.state.loading || this.state.error) {
        return React.createElement(opts.loading, {
          isLoading: this.state.loading,
          pastDelay: this.state.pastDelay,
          timedOut: this.state.timedOut,
          error: this.state.error,
          retry: this.retry
        });
      } else if (this.state.loaded) {
        return opts.render(this.state.loaded, this.props);
      } else {
        return null;
      }
    }
  };
}

function Loadable(opts) {
  return createLoadableComponent(load, opts);
}

function LoadableMap(opts) {
  if (typeof opts.render !== "function") {
    throw new Error("LoadableMap requires a `render(loaded, props)` function");
  }

  return createLoadableComponent(loadMap, opts);
}

Loadable.Map = LoadableMap;

class Capture extends React.Component {
  static propTypes = {
    report: PropTypes.func.isRequired
  };

  static childContextTypes = {
    loadable: PropTypes.shape({
      report: PropTypes.func.isRequired
    }).isRequired
  };

  getChildContext() {
    return {
      loadable: {
        report: this.props.report
      }
    };
  }

  render() {
    return React.Children.only(this.props.children);
  }
}

Loadable.Capture = Capture;

function flushInitializers(initializers) {
  let promises = [];

  while (initializers.length) {
    let init = initializers.pop();
    promises.push(init());
  }

  return Promise.all(promises).then(() => {
    if (initializers.length) {
      return flushInitializers(initializers);
    }
  });
}

Loadable.preloadAll = () => {
  return new Promise((resolve, reject) => {
    flushInitializers(ALL_INITIALIZERS).then(resolve, reject);
  });
};

Loadable.preloadReady = () => {
  return new Promise((resolve, reject) => {
    // We always will resolve, errors should be handled within loading UIs.
    flushInitializers(READY_INITIALIZERS).then(resolve, resolve);
  });
};

/**
 * Wait for all loadables to load that've been explicitly initialized.
 * This is distinct from preloadAll which loads all loadables wether
 * or not they are ever used.
 */
Loadable.waitForLoad = () => {
  return new Promise((resolve, reject) => {
    flushInitializers(CONSTRUCTED_INITIALIZERS).then(resolve, reject);
  });
};

/**
 * Checks to see if all loadables, that have been initialized, have loaded.
 * To be used in conjunction with waitForLoad.
 */
Loadable.areAllLoaded = () => CONSTRUCTED_RESULTS.every(res => !res.loading);

module.exports = Loadable;
