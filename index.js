var camelCase = require('camelcase')
var decamelize = require('decamelize')
var path = require('path')
var tokenizeArgString = require('./lib/tokenize-arg-string')
var util = require('util')

function parse (args, opts) {
  if (!opts) opts = {}
  // allow a string argument to be passed in rather
  // than an argv array.
  const $tokens = tokenizeArgString(args).map(arg => ({ $token: arg }))

  // aliases might have transitive relationships, normalize this.
  var aliases = combineAliases(opts.alias || {})
  var configuration = Object.assign({
    'short-option-groups': true,
    'camel-case-expansion': true,
    'dot-notation': true,
    'parse-numbers': true,
    'boolean-negation': true,
    'negation-prefix': 'no-',
    'duplicate-arguments-array': true,
    'flatten-duplicate-arrays': true,
    'populate--': false,
    'combine-arrays': false,
    'set-placeholder-key': false,
    'halt-at-non-option': false,
    'strip-aliased': false,
    'strip-dashed': false,
    'unknown-options-as-args': false
  }, opts.configuration)
  var defaults = opts.default || {}
  var configObjects = opts.configObjects || []
  var envPrefix = opts.envPrefix
  var notFlagsOption = configuration['populate--']
  var notFlagsArgv = notFlagsOption ? '--' : '_'
  var newAliases = {}
  var defaulted = {}
  // allow a i18n handler to be passed in, default to a fake one (util.format).
  var __ = opts.__ || util.format
  var error = null
  var flags = {
    aliases: {},
    arrays: {},
    bools: {},
    strings: {},
    numbers: {},
    counts: {},
    normalize: {},
    hide: {},
    configs: {},
    nargs: {},
    coercions: {},
    keys: []
  }
  var negative = /^-([0-9]+(\.[0-9]+)?|\.[0-9]+)$/
  var negatedBoolean = new RegExp('^--' + configuration['negation-prefix'] + '(.+)')

  ;[].concat(opts.array).filter(Boolean).forEach(function (opt) {
    var key = opt.key || opt

    // assign to flags[bools|strings|numbers]
    const assignment = Object.keys(opt).map(function (key) {
      return ({
        boolean: 'bools',
        string: 'strings',
        number: 'numbers'
      })[key]
    }).filter(Boolean).pop()

    // assign key to be coerced
    if (assignment) {
      flags[assignment][key] = true
    }

    flags.arrays[key] = true
    flags.keys.push(key)
  })

  ;[].concat(opts.boolean).filter(Boolean).forEach(function (key) {
    flags.bools[key] = true
    flags.keys.push(key)
  })

  ;[].concat(opts.string).filter(Boolean).forEach(function (key) {
    flags.strings[key] = true
    flags.keys.push(key)
  })

  ;[].concat(opts.number).filter(Boolean).forEach(function (key) {
    flags.numbers[key] = true
    flags.keys.push(key)
  })

  ;[].concat(opts.count).filter(Boolean).forEach(function (key) {
    flags.counts[key] = true
    flags.keys.push(key)
  })

  ;[].concat(opts.normalize).filter(Boolean).forEach(function (key) {
    flags.normalize[key] = true
    flags.keys.push(key)
  })

  ;[].concat(opts.hide).filter(Boolean).forEach(function (key) {
    flags.hide[key] = true
    flags.keys.push(key)
  })

  Object.keys(opts.narg || {}).forEach(function (k) {
    flags.nargs[k] = opts.narg[k]
    flags.keys.push(k)
  })

  Object.keys(opts.coerce || {}).forEach(function (k) {
    flags.coercions[k] = opts.coerce[k]
    flags.keys.push(k)
  })

  if (Array.isArray(opts.config) || typeof opts.config === 'string') {
    ;[].concat(opts.config).filter(Boolean).forEach(function (key) {
      flags.configs[key] = true
    })
  } else {
    Object.keys(opts.config || {}).forEach(function (k) {
      flags.configs[k] = opts.config[k]
    })
  }

  // create a lookup table that takes into account all
  // combinations of aliases: {f: ['foo'], foo: ['f']}
  extendAliases(opts.key, aliases, opts.default, flags.arrays)

  // apply default values to all aliases.
  Object.keys(defaults).forEach(function (key) {
    (flags.aliases[key] || []).forEach(function (alias) {
      defaults[alias] = defaults[key]
    })
  })

  checkConfiguration()

  const $argv = { _: { $ref: [], $value: [], hide } }
  let notFlags = []

  for (let i = 0; i < $tokens.length; ++i) {
    const tokenRef = $tokens[i]
    if (isUndefined(tokenRef)) continue
    let arg = tokenRef.$token
    var broken
    var key
    var letters
    var m
    var next
    var value

    // any unknown option (except for end-of-options, "--")
    if (arg !== '--' && isUnknownOptionAsArg(arg)) {
      // console.log('pushing unknown option %O to _', tokenRef)
      $argv._.$value.push(arg)
      $argv._.$ref.push(tokenRef)
    } else if (
      arg.match(/^--.+=/) || (
        !configuration['short-option-groups'] && arg.match(/^-.+=/)
      )
    ) { // -- separated by =
      // Using [\s\S] instead of . because js doesn't support the
      // 'dotall' regex modifier. See:
      // http://stackoverflow.com/a/1068308/13216
      m = arg.match(/^--?([^=]+)=([\s\S]*)$/)
      // flag = arg.match(/^(--?[^=]+)=([\s\S]*)$/)[1]

      // nargs format = '--f=monkey washing cat'
      if (checkAllAliases(m[1], flags.nargs)) {
        $tokens.splice(i + 1, 0, { $token: m[2] })
        i = eatNargs(i, m[1], $tokens)
      // arrays format = '--f=a b c'
      } else if (checkAllAliases(m[1], flags.arrays)) {
        $tokens.splice(i + 1, 0, { $token: m[2] })
        i = eatArray(i, m[1], $tokens)
      } else {
        tokenRef.$value = m[2]
        setArg(m[1], tokenRef).possiblyHide()
      }
    } else if (arg.match(negatedBoolean) && configuration['boolean-negation']) {
      key = arg.match(negatedBoolean)[1]
      tokenRef.$value = checkAllAliases(key, flags.arrays) ? [false] : false
      setArg(key, tokenRef).possiblyHide()
    } else if (arg.match(/^--.+/) || (
      !configuration['short-option-groups'] && arg.match(/^-[^-]+/)
    )) { // -- separated by space.
      key = arg.match(/^--?(.+)/)[1]

      // nargs format = '--foo a b c'
      // should be truthy even if: flags.nargs[key] === 0
      if (checkAllAliases(key, flags.nargs) !== false) {
        i = eatNargs(i, key, $tokens)
      // array format = '--foo a b c'
      } else if (checkAllAliases(key, flags.arrays)) {
        i = eatArray(i, key, $tokens)
      } else {
        next = $tokens[i + 1]

        if (
          !isUndefined(next) &&
          !isUndefined(next.$token) &&
          (!next.$token.match(/^-/) || next.$token.match(negative)) &&
          !checkAllAliases(key, flags.bools) &&
          !checkAllAliases(key, flags.counts)
        ) {
          tokenRef.$value = next.$token
          setArg(key, tokenRef)
            .pushRef(next)
            .possiblyHide()
          next.$value = tokenRef.$value
          i++
        } else if (!isUndefined(next) && !isUndefined(next.$token) && /^(true|false)$/.test(next.$token)) {
          tokenRef.$value = next.$token
          setArg(key, tokenRef)
            .pushRef(next)
            .possiblyHide()
          next.$value = tokenRef.$value
          i++
        } else {
          tokenRef.$value = defaultValue(key)
          setArg(key, tokenRef).possiblyHide()
        }
      }
    } else if (arg.match(/^-.\..+=/)) { // dot-notation flag separated by '='.
      m = arg.match(/^-([^=]+)=([\s\S]*)$/)
      tokenRef.$value = m[2]
      setArg(m[1], tokenRef).possiblyHide()
    } else if (arg.match(/^-.\..+/) && !arg.match(negative)) {
      next = $tokens[i + 1]
      key = arg.match(/^-(.\..+)/)[1]

      if (
        next !== undefined &&
        !next.$token.match(/^-/) &&
        !checkAllAliases(key, flags.bools) &&
        !checkAllAliases(key, flags.counts)
      ) {
        tokenRef.$value = next.$token
        setArg(key, tokenRef).possiblyHide()
        i++
      } else {
        tokenRef.$value = defaultValue(key)
        setArg(key, tokenRef).possiblyHide()
      }
    } else if (arg.match(/^-[^-]+/) && !arg.match(negative)) {
      // dot-notation flag separated by space.
      letters = arg.slice(1, -1).split('')
      broken = false

      for (var j = 0; j < letters.length; ++j) {
        next = arg.slice(j + 2)

        if (letters[j + 1] && letters[j + 1] === '=') {
          value = arg.slice(j + 3)
          key = letters[j]

          // nargs format = '-f=monkey washing cat'
          if (checkAllAliases(key, flags.nargs)) {
            tokenRef.$token = letters.slice(0, j + 1)
            $tokens.splice(i + 1, 0, { $token: value })
            i = eatNargs(i, key, $tokens)
          // array format = '-f=a b c'
          } else if (checkAllAliases(key, flags.arrays)) {
            tokenRef.$token = letters.slice(0, j + 1)
            $tokens.splice(i + 1, 0, { $token: value })
            i = eatArray(i, key, $tokens)
          } else {
            tokenRef.$value = value
            setArg(key, tokenRef).possiblyHide()
          }

          broken = true
          break
        }

        if (next === '-') {
          tokenRef.$value = next
          setArg(letters[j], tokenRef).possiblyHide()
          continue
        }

        // current letter is an alphabetic character and next value is a number
        if (
          /[A-Za-z]/.test(letters[j]) &&
          /^-?\d+(\.\d*)?(e-?\d+)?$/.test(next)
        ) {
          tokenRef.$value = next
          setArg(letters[j], tokenRef).possiblyHide()
          broken = true
          break
        }

        if (letters[j + 1] && letters[j + 1].match(/\W/)) {
          tokenRef.$value = next
          setArg(letters[j], tokenRef).possiblyHide()
          broken = true
          break
        } else {
          tokenRef.$value = defaultValue(letters[j])
          setArg(letters[j], tokenRef).possiblyHide()
        }
      }

      key = arg.slice(-1)[0]

      if (!broken && key !== '-') {
        // nargs format = '-f a b c'
        // should be truthy even if: flags.nargs[key] === 0
        if (checkAllAliases(key, flags.nargs) !== false) {
          i = eatNargs(i, key, $tokens)
        // array format = '-f a b c'
        } else if (checkAllAliases(key, flags.arrays)) {
          i = eatArray(i, key, $tokens)
        } else {
          next = $tokens[i + 1]

          if (
            next !== undefined &&
            next.$token !== undefined &&
            (!/^(-|--)[^-]/.test(next.$token) || next.$token.match(negative)) &&
            !checkAllAliases(key, flags.bools) &&
            !checkAllAliases(key, flags.counts)
          ) {
            tokenRef.$value = next.$token
            // console.log('setting short option -%s using token %O', key, tokenRef)
            setArg(key, tokenRef)
              .pushRef(next)
              .possiblyHide()
            i++
          } else if (
            next !== undefined &&
            next.$token !== undefined &&
            /^(true|false)$/.test(next.$token)
          ) {
            tokenRef.$value = next.$token
            setArg(key, tokenRef)
              .pushRef(next)
              .possiblyHide()
            i++
          } else {
            tokenRef.$value = defaultValue(key)
            setArg(key, tokenRef).possiblyHide()
          }
        }
      }
    } else if (arg === '--') {
      notFlags = $tokens.slice(i + 1)
      break
    } else if (configuration['halt-at-non-option']) {
      notFlags = $tokens.slice(i)
      break
    } else {
      $argv._.$value.push(maybeCoerceNumber('_', arg))
      $argv._.$ref.push(tokenRef)
    }
  }

  // order of precedence:
  // 1. command line arg
  // 2. value from env var
  // 3. value from config file
  // 4. value from config objects
  // 5. configured default value
  applyEnvVars($argv, true) // special case: check env vars that point to config file
  applyEnvVars($argv, false)
  setConfig($argv)
  setConfigObjects()
  applyDefaultsAndAliases($argv, flags.aliases, defaults, true)
  applyCoercions($argv)
  if (configuration['set-placeholder-key']) setPlaceholderKeys($argv)

  // for any counts either not in args or without an explicit default, set to 0
  Object.keys(flags.counts).forEach(function (key) {
    if (!hasKey($argv, key.split('.'))) setArg(key, { $ref: [], $value: 0 }).possiblyHide()
  })

  // '--' defaults to undefined.
  if (notFlagsOption && notFlags.length) $argv[notFlagsArgv] = { $value: [], $ref: [] }
  notFlags.forEach(function (tokenRef) {
    $argv[notFlagsArgv].$ref.push(tokenRef)
    $argv[notFlagsArgv].$value.push(tokenRef.$token)
  })

  if (configuration['camel-case-expansion'] && configuration['strip-dashed']) {
    Object.keys($argv).filter(key => key !== '--' && key.includes('-')).forEach(key => {
      delete $argv[key]
    })
  }

  if (configuration['strip-aliased']) {
    // XXX Switch to [].concat(...Object.values(aliases)) once node.js 6 is dropped
    ;[].concat(...Object.keys(aliases).map(k => aliases[k])).forEach(alias => {
      if (configuration['camel-case-expansion']) {
        delete $argv[alias.split('.').map(prop => camelCase(prop)).join('.')]
      }

      delete $argv[alias]
    })
  }

  // how many arguments should we consume, based
  // on the nargs option?
  function eatNargs (i, key, tokens) {
    var ii
    const toEat = checkAllAliases(key, flags.nargs)
    const nargsRef = []
    if (tokens[i]) nargsRef.push(tokens[i])

    if (toEat === 0) {
      const modifiedKeys = setArg(key, { $value: defaultValue(key) })
      modifiedKeys.forEach(key => {
        key.$ref = nargsRef
      })
      modifiedKeys.possiblyHide()
      return i
    }

    // nargs will not consume flag arguments, e.g., -abc, --foo,
    // and terminates when one is observed.
    var available = 0
    for (ii = i + 1; ii < tokens.length; ii++) {
      if (!tokens[ii].$token.match(/^-[^0-9]/) || tokens[ii].$token.match(negative) || isUnknownOptionAsArg(tokens[ii].$token)) available++
      else break
    }

    if (available < toEat) error = Error(__('Not enough arguments following: %s', key))

    const consumed = Math.min(available, toEat)
    const modifiedKeys = []
    for (ii = i + 1; ii < (consumed + i + 1); ii++) {
      const tokenRef = tokens[ii]
      nargsRef.push(tokenRef)
      modifiedKeys.push(setArg(key, tokenRef))
    }
    modifiedKeys.forEach(keys => {
      keys.forEach(key => { key.$ref = nargsRef })
    })
    modifiedKeys.forEach(keys => { keys.possiblyHide() })

    return (i + consumed)
  }

  // if an option is an array, eat all non-hyphenated arguments
  // following it... YUM!
  // e.g., --foo apple banana cat becomes ["apple", "banana", "cat"]
  function eatArray (i, key, $tokens) {
    let next = $tokens[i + 1]
    const arrayRef = { $ref: [], $value: [] }
    // console.log('eatArray: eating %O', $tokens.slice(i + 1, $tokens.length))

    if (
      checkAllAliases(key, flags.bools) &&
      (isUndefined(next) || !(/^(true|false)$/.test(next.$token)))
    ) {
      arrayRef.$value.push(true)
      if (next) {
        arrayRef.$ref.push(next)
        if (next.$token) arrayRef.$token = next.$token
      }
      // console.log('eatArray: new array after pushing true: %O', arrayRef)
    } else if (
      isUndefined(next) ||
      isUndefined(next.$token) ||
      (/^-/.test(next.$token) &&
      !negative.test(next.$token) &&
      !isUnknownOptionAsArg(next.$token))
    ) {
      // for keys without value ==> argsToSet remains an empty []
      // set user default value, if available
      if (defaults.hasOwnProperty(key)) {
        if (next) {
          arrayRef.$ref.push(next)
          if (next.$token) arrayRef.$token = next.$token
        }
        const defVal = defaults[key]
        if (Array.isArray(defVal)) arrayRef.$value = arrayRef.$value.concat(defVal)
        else arrayRef.$value.push(defVal)
      }
    } else {
      arrayRef.$token = []
      for (var ii = i + 1; ii < $tokens.length; ++ii) {
        next = $tokens[ii]
        if (
          isUndefined(next) ||
          (
            /^-/.test(next.$token) &&
            !negative.test(next.$token) &&
            !isUnknownOptionAsArg(next.$token)
          )
        ) break
        i = ii
        processValue(key, next)
        arrayRef.$token.push(next.$token)
        arrayRef.$ref.push(next)
        arrayRef.$value.push(next.$value)
      }
      arrayRef.$token = arrayRef.$token.join(' ')
    }

    // console.log('eatArray: setting key %O using token %O', key, arrayRef)
    setArg(key, arrayRef).possiblyHide()
    return i
  }

  function setArg (key, token) {
    if (/-/.test(key) && configuration['camel-case-expansion']) {
      var alias = key.split('.').map(function (prop) {
        return camelCase(prop)
      }).join('.')
      addNewAlias(key, alias)
    }

    processValue(key, token)

    var splitKey = key.split('.')
    const modifiedKeys = []
    modifiedKeys.push(setKey($argv, splitKey, token))

    // handle populating aliases of the full key
    if (flags.aliases[key]) {
      flags.aliases[key].forEach(function (x) {
        x = x.split('.')
        modifiedKeys.push(setKey($argv, x, token))
      })
    }

    // handle populating aliases of the first element of the dot-notation key
    if (splitKey.length > 1 && configuration['dot-notation']) {
      ;(flags.aliases[splitKey[0]] || []).forEach(function (x) {
        x = x.split('.')

        // expand alias with nested objects in key
        var a = [].concat(splitKey)
        a.shift() // nuke the old key.
        x = x.concat(a)

        modifiedKeys.push(setKey($argv, x, token))
      })
    }

    // Set normalize getter and setter when key is in 'normalize' but isn't an array
    // FIXME: make this work with refs
    // if (checkAllAliases(key, flags.normalize) && !checkAllAliases(key, flags.arrays)) {
    //   var keys = [key].concat(flags.aliases[key] || [])
    //   keys.forEach(function (key) {
    //     $argv.__defineSetter__(key, function (v) {
    //       token.$token = path.normalize(v)
    //     })
    //
    //     $argv.__defineGetter__(key, function () {
    //       return typeof token.$token === 'string' ? path.normalize(token.$token) : token.$token
    //     })
    //   })
    // }
    modifiedKeys.pushRef = (ref) => {
      modifiedKeys.forEach(x => {
        x.$ref.push(ref)
      })
      return modifiedKeys
    }
    modifiedKeys.possiblyHide = (k = key) => {
      modifiedKeys.forEach(x => {
        x.possiblyHide(k)
      })
      return modifiedKeys
    }
    return modifiedKeys
  }

  function hide () { // remove token references in $ref of this tokenRef
    this.$ref.forEach(token => { token.$token = null })
  }

  function possiblyHide (key) { // hide if hide[key] is true
    if (checkAllAliases(key, flags.hide)) {
      this.hide()
    }
  }

  function addNewAlias (key, alias) {
    if (!(flags.aliases[key] && flags.aliases[key].length)) {
      flags.aliases[key] = [alias]
      newAliases[alias] = true
    }
    if (!(flags.aliases[alias] && flags.aliases[alias].length)) {
      addNewAlias(alias, key)
    }
  }

  function processValue (key, token) {
    // console.log('Processing token %O for key %O', token, key)
    // strings may be quoted, clean this up as we assign values.
    let val = token.hasOwnProperty('$value') ? token.$value : token.$token
    if (typeof val === 'string' &&
      (val[0] === "'" || val[0] === '"') &&
      val[val.length - 1] === val[0]
    ) {
      val = val.substring(1, val.length - 1)
    }

    // handle parsing boolean arguments --foo=true --bar false.
    if (checkAllAliases(key, flags.bools) || checkAllAliases(key, flags.counts)) {
      if (typeof val === 'string') val = val === 'true'
    }

    var value = Array.isArray(val)
      ? val.map(v => maybeCoerceNumber(key, v))
      : maybeCoerceNumber(key, val)

    // increment a count given as arg (either no value or value parsed as boolean)
    if (checkAllAliases(key, flags.counts) && (isUndefined(value) || typeof value === 'boolean')) {
      value = Symbol.for('increment')
    }

    // Set normalized value when key is in 'normalize'
    if (checkAllAliases(key, flags.normalize)) {
      if (Array.isArray(val)) {
        if (val.every(v => (typeof v === 'string'))) value = val.map(p => path.normalize(p))
      } else {
        if (typeof val === 'string') value = path.normalize(val)
      }
    }
    token.$value = value
    // console.log('New value token: %O', token)
    return token
  }

  function maybeCoerceNumber (key, value) {
    if (!checkAllAliases(key, flags.strings) && !checkAllAliases(key, flags.bools) && !Array.isArray(value)) {
      const shouldCoerceNumber = isNumber(value) && configuration['parse-numbers'] && (
        Number.isSafeInteger(Math.floor(value))
      )
      if (shouldCoerceNumber || (!isUndefined(value) && checkAllAliases(key, flags.numbers))) value = Number(value)
    }
    return value
  }

  // set args from config.json file, this should be
  // applied last so that defaults can be applied.
  function setConfig ($argv) {
    var configLookup = {}

    // expand defaults/aliases, in-case any happen to reference
    // the config.json file.
    applyDefaultsAndAliases(configLookup, flags.aliases, defaults)

    Object.keys(flags.configs).forEach(function (configKey) {
      var configPath = ($argv[configKey] || configLookup[configKey] || { $value: null }).$value
      if (configPath) {
        try {
          var config = null
          var resolvedConfigPath = path.resolve(process.cwd(), configPath)

          if (typeof flags.configs[configKey] === 'function') {
            try {
              config = flags.configs[configKey](resolvedConfigPath)
            } catch (e) {
              config = e
            }
            if (config instanceof Error) {
              error = config
              return
            }
          } else {
            config = require(resolvedConfigPath)
          }

          setConfigObject(config)
        } catch (ex) {
          if ($argv[configKey]) error = Error(__('Invalid JSON config file: %s', configPath))
        }
      }
    })
  }

  // set args from config object.
  // it recursively checks nested objects.
  function setConfigObject (config, prev) {
    Object.keys(config).forEach(function (key) {
      var value = config[key]
      var fullKey = prev ? prev + '.' + key : key

      // if the value is an inner object and we have dot-notation
      // enabled, treat inner objects in config the same as
      // heavily nested dot notations (foo.bar.apple).
      if (typeof value === 'object' && value !== null && !Array.isArray(value) && configuration['dot-notation']) {
        // if the value is an object but not an array, check nested object
        setConfigObject(value, fullKey)
      } else {
        // setting arguments via CLI takes precedence over
        // values within the config file.
        if (
          !hasKey($argv, fullKey.split('.')) ||
          (checkAllAliases(fullKey, flags.arrays) &&
          configuration['combine-arrays'])
        ) {
          setArg(fullKey, { $ref: [], $value: value }).possiblyHide()
        }
      }
    })
  }

  // set all config objects passed in opts
  function setConfigObjects () {
    if (typeof configObjects === 'undefined') return
    configObjects.forEach(function (configObject) {
      setConfigObject(configObject)
    })
  }

  function applyEnvVars (argv, configOnly) {
    if (typeof envPrefix === 'undefined') return

    var prefix = typeof envPrefix === 'string' ? envPrefix : ''
    Object.keys(process.env).forEach(function (envVar) {
      if (prefix === '' || envVar.lastIndexOf(prefix, 0) === 0) {
        // get array of nested keys and convert them to camel case
        var keys = envVar.split('__').map(function (key, i) {
          if (i === 0) {
            key = key.substring(prefix.length)
          }
          return camelCase(key)
        })

        if (((configOnly && flags.configs[keys.join('.')]) || !configOnly) && !hasKey(argv, keys)) {
          setArg(keys.join('.'), { $ref: [], $value: process.env[envVar] }).possiblyHide()
        }
      }
    })
  }

  function applyCoercions ($argv) {
    var coerce
    var applied = {}
    Object.keys($argv).forEach(function (key) {
      if (!applied.hasOwnProperty(key)) { // If we haven't already coerced this option via one of its aliases
        coerce = checkAllAliases(key, flags.coercions)
        if (typeof coerce === 'function') {
          try {
            // FIXME: the coercion should apply to the flattened value so that modifying nested keys
            //       works intuitively.
            var value = maybeCoerceNumber(key, coerce($argv[key].$value))
            ;([].concat(flags.aliases[key] || [], key)).forEach(ali => {
              applied[ali] = $argv[ali].$value = value
            })
          } catch (err) {
            error = err
          }
        }
      }
    })
  }

  function setPlaceholderKeys (argv) {
    flags.keys.forEach((key) => {
      // don't set placeholder keys for dot notation options 'foo.bar'.
      if (~key.indexOf('.')) return
      if (typeof argv[key] === 'undefined') argv[key] = undefined
    })
    return argv
  }

  function applyDefaultsAndAliases (obj, aliases, defaults, canLog = false) {
    // console.log('applying defaults and aliases')
    Object.keys(defaults).forEach(function (key) {
      // console.log('setting defaults for key %O', key)
      if (!hasKey(obj, key.split('.'))) {
        setKey(obj, key.split('.'), { $ref: [], $value: defaults[key] })
        if (canLog) defaulted[key] = true

        ;(aliases[key] || []).forEach(function (x) {
          if (hasKey(obj, x.split('.'))) return
          setKey(obj, x.split('.'), { $ref: [], $value: defaults[key] })
        })
      }
    })
  }

  function hasKey (obj, keys) {
    var o = obj
    if (!obj) return false

    if (!configuration['dot-notation']) keys = [keys.join('.')]

    if (!keys.slice(0, -1).every(key => {
      if (o) o = (o[key] || { $value: null }).$value
      else return false
      return true
    })) return false

    var key = keys[keys.length - 1]

    const _has = (typeof o === 'object' && o !== null && key in o)
    // console.log('hasKey: %s key %O in object %O', _has? 'found': 'did not find', keys, obj)
    return _has
  }

  function setKey (obj, keys, token) {
    var o = obj

    if (!configuration['dot-notation']) keys = [keys.join('.')]

    keys.slice(0, -1).forEach(key => {
      if (typeof o === 'object' && o[key] === undefined) {
        o[key] = { $value: {} }
      }

      if (typeof o[key].$value !== 'object' || Array.isArray(o[key].$value)) {
        // ensure that o[key].$value is an array, and that the last item is an empty object.
        if (Array.isArray(o[key].$value)) {
          o[key].$value.push({})
        } else {
          o[key].$value = [o[key].$value, {}]
        }

        // we want to update the empty object at the end of the o[key].$value array, so set o to that object
        o = o[key].$value[o[key].$value.length - 1]
      } else {
        o = o[key].$value
      }
    })

    var key = keys[keys.length - 1]

    // console.log('Setting key "%O" to token value "%O" in object %O', key, token, o)

    var isTypeArray = checkAllAliases(keys.join('.'), flags.arrays)
    var isValueArray = Array.isArray(token.$value)
    var duplicate = configuration['duplicate-arguments-array']

    // nargs has higher priority than duplicate
    if (!duplicate && checkAllAliases(key, flags.nargs)) {
      duplicate = true
      if (
        (!isUndefined(o[key]) && !isUndefined(o[key].$value) && flags.nargs[key] === 1) ||
        (!isUndefined(o[key]) && Array.isArray(o[key].$value) && o[key].$value.length === flags.nargs[key])
      ) {
        o[key].$value = undefined
      }
    }

    if (token.$value === Symbol.for('increment')) {
      if (isUndefined(o[key])) o[key] = {}
      if (typeof o[key].$value === 'number') o[key].$value++
      else o[key].$value = 1
    } else if (!!o[key] && !!o[key].$value && Array.isArray(o[key].$value)) {
      if (duplicate && isTypeArray && isValueArray) {
        o[key].$value = configuration['flatten-duplicate-arrays'] ? o[key].$value.concat(token.$value) : (Array.isArray(o[key].$value[0]) ? o[key].$value : [o[key].$value]).concat([token.$value])
      } else if (!duplicate && Boolean(isTypeArray) === Boolean(isValueArray)) {
        o[key].$value = token.$value
      } else {
        o[key].$value = o[key].$value.concat([token.$value])
      }
    } else if ((o[key] === undefined || o[key].$value === undefined) && isTypeArray) {
      if (o[key] === undefined) o[key] = {}
      o[key].$value = isValueArray ? token.$value : [token.$value]
    } else if (duplicate && !((o[key] === undefined || o[key].$value === undefined) || checkAllAliases(key, flags.counts))) {
      o[key].$value = [o[key].$value, token.$value]
    } else {
      if (o[key] === undefined) o[key] = {}
      o[key].$value = token.$value
    }

    if (!Array.isArray(o[key].$ref)) o[key].$ref = []
    o[key].$ref.push(token)
    o[key].hide = hide
    o[key].possiblyHide = possiblyHide
    // console.log('setKey: result = %O', obj)
    return o[key]
  }

  // extend the aliases list with inferred aliases.
  function extendAliases (...args) {
    args.forEach(function (obj) {
      Object.keys(obj || {}).forEach(function (key) {
        // short-circuit if we've already added a key
        // to the aliases array, for example it might
        // exist in both 'opts.default' and 'opts.key'.
        if (flags.aliases[key]) return

        flags.aliases[key] = [].concat(aliases[key] || [])
        // For "--option-name", also set argv.optionName
        flags.aliases[key].concat(key).forEach(function (x) {
          if (/-/.test(x) && configuration['camel-case-expansion']) {
            var c = camelCase(x)
            if (c !== key && flags.aliases[key].indexOf(c) === -1) {
              flags.aliases[key].push(c)
              newAliases[c] = true
            }
          }
        })
        // For "--optionName", also set argv['option-name']
        flags.aliases[key].concat(key).forEach(function (x) {
          if (x.length > 1 && /[A-Z]/.test(x) && configuration['camel-case-expansion']) {
            var c = decamelize(x, '-')
            if (c !== key && flags.aliases[key].indexOf(c) === -1) {
              flags.aliases[key].push(c)
              newAliases[c] = true
            }
          }
        })
        flags.aliases[key].forEach(function (x) {
          flags.aliases[x] = [key].concat(flags.aliases[key].filter(function (y) {
            return x !== y
          }))
        })
      })
    })
  }

  // return the 1st set flag for any of a key's aliases (or false if no flag set)
  function checkAllAliases (key, flag) {
    var toCheck = [].concat(key, flags.aliases[key] || [])
    let setAlias = toCheck.find(key => flag.hasOwnProperty(key))
    return setAlias ? flag[setAlias] : false
  }

  function hasAnyFlag (key) {
    // XXX Switch to [].concat(...Object.values(flags)) once node.js 6 is dropped
    var toCheck = [].concat(...Object.keys(flags).map(k => flags[k]))

    return toCheck.some(function (flag) {
      return flag[key]
    })
  }

  function hasFlagsMatching (arg, ...patterns) {
    var toCheck = [].concat(...patterns)
    return toCheck.some(function (pattern) {
      var match = arg.match(pattern)
      return match && hasAnyFlag(match[1])
    })
  }

  // based on a simplified version of the short flag group parsing logic
  function hasAllShortFlags (arg) {
    // if this is a negative number, or doesn't start with a single hyphen, it's not a short flag group
    if (arg.match(negative) || !arg.match(/^-[^-]+/)) { return false }
    var hasAllFlags = true
    var letters = arg.slice(1).split('')
    var next
    for (var j = 0; j < letters.length; j++) {
      next = arg.slice(j + 2)

      if (!hasAnyFlag(letters[j])) {
        hasAllFlags = false
        break
      }

      if ((letters[j + 1] && letters[j + 1] === '=') ||
        next === '-' ||
        (/[A-Za-z]/.test(letters[j]) && /^-?\d+(\.\d*)?(e-?\d+)?$/.test(next)) ||
        (letters[j + 1] && letters[j + 1].match(/\W/))) {
        break
      }
    }
    return hasAllFlags
  }

  function isUnknownOptionAsArg (arg) {
    return configuration['unknown-options-as-args'] && isUnknownOption(arg)
  }

  function isUnknownOption (arg) {
    // ignore negative numbers
    if (arg.match(negative)) { return false }
    // if this is a short option group and all of them are configured, it isn't unknown
    if (hasAllShortFlags(arg)) { return false }
    // e.g. '--count=2'
    const flagWithEquals = /^-+([^=]+?)=[\s\S]*$/
    // e.g. '-a' or '--arg'
    const normalFlag = /^-+([^=]+?)$/
    // e.g. '-a-'
    const flagEndingInHyphen = /^-+([^=]+?)-$/
    // e.g. '-abc123'
    const flagEndingInDigits = /^-+([^=]+?)\d+$/
    // e.g. '-a/usr/local'
    const flagEndingInNonWordCharacters = /^-+([^=]+?)\W+.*$/
    // check the different types of flag styles, including negatedBoolean, a pattern defined near the start of the parse method
    return !hasFlagsMatching(arg, flagWithEquals, negatedBoolean, normalFlag, flagEndingInHyphen, flagEndingInDigits, flagEndingInNonWordCharacters)
  }

  // make a best effor to pick a default value
  // for an option based on name and type.
  function defaultValue (key) {
    if (!checkAllAliases(key, flags.bools) &&
        !checkAllAliases(key, flags.counts) &&
        `${key}` in defaults) {
      return defaults[key]
    } else {
      return defaultForType(guessType(key))
    }
  }

  // return a default value, given the type of a flag.,
  // e.g., key of type 'string' will default to '', rather than 'true'.
  function defaultForType (type) {
    var def = {
      boolean: true,
      string: '',
      number: undefined,
      array: []
    }

    return def[type]
  }

  // given a flag, enforce a default type.
  function guessType (key) {
    var type = 'boolean'

    if (checkAllAliases(key, flags.strings)) type = 'string'
    else if (checkAllAliases(key, flags.numbers)) type = 'number'
    else if (checkAllAliases(key, flags.bools)) type = 'boolean'
    else if (checkAllAliases(key, flags.arrays)) type = 'array'

    return type
  }

  function isNumber (x) {
    if (x === null || x === undefined) return false
    // if loaded from config, may already be a number.
    if (typeof x === 'number') return true
    // hexadecimal.
    if (/^0x[0-9a-f]+$/i.test(x)) return true
    // don't treat 0123 as a number; as it drops the leading '0'.
    if (x.length > 1 && x[0] === '0') return false
    return /^[-]?(?:\d+(?:\.\d*)?|\.\d+)(e[-+]?\d+)?$/.test(x)
  }

  // check user configuration settings for inconsistencies
  function checkConfiguration () {
    // count keys should not be set as array/narg
    Object.keys(flags.counts).find(key => {
      if (checkAllAliases(key, flags.arrays)) {
        error = Error(__('Invalid configuration: %s, opts.count excludes opts.array.', key))
        return true
      } else if (checkAllAliases(key, flags.nargs)) {
        error = Error(__('Invalid configuration: %s, opts.count excludes opts.narg.', key))
        return true
      }
    })
  }

  const ret = {
    error,
    newAliases,
    defaulted,
    configuration,
    $ref: {
      $argv,
      $tokens
    },
    aliases: flags.aliases
  }

  function flattenRefs (ref, flatKey = '$value', seen = new Set()) {
    if (seen.has(ref)) return ref
    seen.add(ref)
    if (ref === null || typeof ref !== 'object') return ref
    if (Array.isArray(ref)) {
      const ret = []
      for (let ii in ref) {
        ret[ii] = flattenRefs(ref[ii], flatKey, seen)
      }
      return ret
    }
    let ret = {}
    const keys = Object.keys(ref)
    if (keys.includes(flatKey)) {
      return flattenRefs(ref[flatKey], flatKey, seen)
    }
    keys.forEach(key => {
      ret[key] = flattenRefs(ref[key], flatKey, seen)
    })
    return ret
  }

  Object.defineProperty(ret, 'argv', {
    get () {
      return flattenRefs(this.$ref.$argv, '$value')
    }
  })

  Object.defineProperty(ret, 'tokens', {
    get () {
      return flattenRefs(this.$ref.$tokens, '$token').filter(x => (typeof x === 'string'))
    }
  })

  return ret
}

// if any aliases reference each other, we should
// merge them together.
function combineAliases (aliases) {
  var aliasArrays = []
  var change = true
  var combined = {}

  // turn alias lookup hash {key: ['alias1', 'alias2']} into
  // a simple array ['key', 'alias1', 'alias2']
  Object.keys(aliases).forEach(function (key) {
    aliasArrays.push(
      [].concat(aliases[key], key)
    )
  })

  // combine arrays until zero changes are
  // made in an iteration.
  while (change) {
    change = false
    for (var i = 0; i < aliasArrays.length; i++) {
      for (var ii = i + 1; ii < aliasArrays.length; ii++) {
        var intersect = aliasArrays[i].filter(function (v) {
          return aliasArrays[ii].indexOf(v) !== -1
        })

        if (intersect.length) {
          aliasArrays[i] = aliasArrays[i].concat(aliasArrays[ii])
          aliasArrays.splice(ii, 1)
          change = true
          break
        }
      }
    }
  }

  // map arrays back to the hash-lookup (de-dupe while
  // we're at it).
  aliasArrays.forEach(function (aliasArray) {
    aliasArray = aliasArray.filter(function (v, i, self) {
      return self.indexOf(v) === i
    })
    combined[aliasArray.pop()] = aliasArray
  })

  return combined
}

function isUndefined (num) {
  return num === undefined
}

function Parser (args, opts) {
  var result = parse(args.slice(), opts)

  return result.argv
}

// parse arguments and return detailed
// meta information, aliases, etc.
Parser.detailed = function (args, opts) {
  return parse(args.slice(), opts)
}

module.exports = Parser
