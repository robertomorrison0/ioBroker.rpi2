/**
 *      RPI-Monitor Adapter
 *
 *      License: MIT
 */
'use strict';

const utils = require('@iobroker/adapter-core'); // Get common adapter utils
let gpio;
let errorsLogged = {};

// Which button events will we capture and have states for?
// See https://www.npmjs.com/package/rpi-gpio-buttons
const buttonEvents = [ 'pressed', 'clicked', 'clicked_pressed', 'double_clicked', 'released' ];

const adapter = new utils.Adapter({
    name: 'rpi2',

    ready: function () {
        config = adapter.config;
        objects = {};

        if (adapter.config.forceinit) {
            adapter.getAdapterObjects((res) => {
                for (const id of Object.keys(res)) {
                    if (/^rpi2\.\d+$/.test(id)) {
                        adapter.log.debug('Skip root object ' + id);
                        continue;
                    }
                  
                    adapter.log.debug('Remove ' + id + ': ' + id);

                    adapter.delObject(id, (res, err) => {
                        if (res !== undefined && res !== null && res !== 'Not exists') adapter.log.error('res from delObject: ' + res);
                        if (err !== undefined) adapter.log.error('err from delObject: ' + err);
                    });
                    adapter.deleteState(id, (res, err) => {
                        if (res !== undefined && res !== null && res !== 'Not exists') adapter.log.error('res from deleteState: ' + res);
                        if (err !== undefined) adapter.log.error('err from deleteState: ' + err);
                    });
                }
                adapter.subscribeStates('*');
                main();
            });
        } else {
             adapter.getAdapterObjects((res) => {
                for (const id of Object.keys(res)) {
                    objects[id] = true; //object already exists.
                }

                adapter.log.debug('received all objects');
                adapter.subscribeStates('*');
                main();
             });
        }        
    },
    stateChange: function (id, state) {
        adapter.log.debug('stateChange for ' + id + ' found state = ' + JSON.stringify(state));
        if (state && !state.ack) {
            if (id.indexOf('gpio.') !== -1) {
                const parts = id.split('.');
                parts.pop(); // remove state
                writeGpio(parts.pop(), state.val);
            }
        }
    },
    unload: function (callback) {
        if (gpio) {
            gpio.destroy(() => callback && callback());
        } else {
            callback && callback();
        }
    }
});

function writeGpio(port, value) {
    port = parseInt(port, 10);
    if (!adapter.config.gpios[port] || !adapter.config.gpios[port].enabled) {
        adapter.log.warn('Port ' + port + ' is not writable, because disabled.');
        return;
    } else if (adapter.config.gpios[port].input === 'in' || adapter.config.gpios[port].input === 'true' || adapter.config.gpios[port].input === true) {
        return adapter.log.warn('Port ' + port + ' is configured as input and not writable');
    }

    if (value === 'true')  value = true;
    if (value === 'false') value = false;
    if (value === '0')     value = false;
    value = !!value;

    try {
        if (gpio) {
            gpio.write(port, value, err => {
                if (err) {
                    adapter.log.error(err);
                } else {
                    adapter.log.debug('Written ' + value + ' into port ' + port);
                    adapter.setState('gpio.' + port + '.state', value, true);
                }
            });
        } else {
            adapter.log.error('GPIO is not initialized!');
        }
    } catch (error) {
        adapter.log.error('Cannot write port ' + port + ': ' + error);
    }
}

let objects;
let exec;
const rpi      = {};
const table    = {};
let config;
let oldstyle = false;

function main() {
    // TODO: Check which Objects we provide
    setInterval(parser, adapter.config.interval || 60000);

    const version = process.version;
    const va = version.split('.');
    if (va[0] === 'v0' && va[1] === '10') {
        adapter.log.debug('NODE Version = ' + version + ', we need new exec-sync');
        exec     = require('sync-exec');
        oldstyle = true;
    } else {
        adapter.log.debug('NODE Version = ' + version + ', we need new execSync');
        exec     = require('child_process').execSync;
    }
    parser();
    initPorts();
}

function parser() {

    adapter.log.debug('start parsing');

    // Workaround, WebStorm
    if (config === undefined) {
        config = adapter.config;
    }
    for (const c in config) {
        if (!config.hasOwnProperty(c)) continue;

        adapter.log.debug('PARSING: ' + c);

        if (c.indexOf('c_') !== 0 && config['c_' + c] === true) {
            table[c] = new Array(20);
            const o = config[c];
            for (const i in o) {
                if (!o.hasOwnProperty(i)) continue;
                adapter.log.debug('    PARSING: ' + i);
                const object = o[i];
                const command = object.command;
                let regexp;
                if (object.multiline !== undefined) {
                    regexp = new RegExp(object.regexp, 'm');
                } else {
                    regexp = new RegExp(object.regexp);
                }
                const post = object.post;

                adapter.log.debug('---> ' + command);

                let stdout;
                try {
                    if (oldstyle) {
                        stdout = exec(command).stdout;
                    } else {
                        stdout = exec(command).toString();
                    }
                    adapter.log.debug('------------- ' + stdout);
                } catch (er) {
                    adapter.log.debug(er.stack);
                    if (er.pid) console.log('%s (pid: %d) exited with status %d',
                        er.file, er.pid, er.status);
                    // do not process if exec fails
                    continue;
                }

                const match = regexp.exec(stdout);
                adapter.log.debug('---> REGEXP: ' + regexp);
                if (match !== undefined && match !== null && match.length !== undefined) {
                    adapter.log.debug('GROUPS: ' + match.length);
                }
                // TODO: if Group Match is bigger than 2
                // split groups and header into separate objects
                if (match !== undefined && match !== null && match.length > 2) {
                    const lname = i.split(',');
                    for (let m = 1; m < match.length; m++) {
                        const value = match[m];
                        const name = lname[m - 1];
                        adapter.log.debug('MATCHING: ' + value);
                        adapter.log.debug('NAME: ' + name + ', VALULE: ' + value);

                        rpi[name] = value;
                        table[c][i] = value;
                    }
                } else {
                    adapter.log.debug('---> POST:   ' + post);
                    let value;
                    if (match !== undefined && match !== null) {
                        value = match[1];
                    } else {
                        value = stdout;
                    }
                    rpi[i] = value;
                    table[c][i] = value;
                }
            }
        }
    }

    // TODO: Parse twice to get post data and evaluate
    for (const c in config) {
        if (!config.hasOwnProperty(c)) continue;
        adapter.log.debug('CURRENT = ' + c + ' ' + config['c_' + c]);
        adapter.log.debug(c.indexOf('c_'));
        if (c.indexOf('c_') !== 0 && config['c_' + c]) {
            if (objects[c] === undefined) {
                const stateObj = {
                    common: {
                        name:   c, // You can add here some description
                        role:   'sensor'
                    },
                    type:   'device',
                    _id:    c
                };

                adapter.extendObject(c, stateObj);
                objects[c] = true; //remember that we created the object.
            }
            const o = config[c];
            for (const i in o) {
                if (!o.hasOwnProperty(i)) {
                    continue;
                }
                const object = o[i];
                const command = object.command;
                const post = object.post;

                adapter.log.debug('---> POST:   ' + post + ' for ' + i + ' in ' + o);
                let value;

                const lname = i.split(',');
                if (lname !== undefined && lname.length > 1) {
                    for (let m = 0; m < lname.length; m++) {
                        const name = lname[m];
                        value = rpi[name];

                        // TODO: Check if value is number and format it 2 Digits
                        if (!isNaN(value)) {
                            value = parseFloat(value);
                            const re = new RegExp(/^\d+\.\d+$/);
                            if (re.exec(value)) {
                                value = value.toFixed(2);
                            }
                        }

                        adapter.log.debug('MATCHING: ' + value);
                        adapter.log.debug('NAME: ' + name + ' VALUE: ' + value);

                        const objectName = adapter.name + '.' + adapter.instance + '.' + c + '.' + name;
                        adapter.log.debug('SETSTATE FOR ' + objectName + ' VALUE = ' + value);
                        if (objects[objectName] === undefined) {
                            // TODO Create an Object tree
                            const stateObj = {
                                common: {
                                    name:  objectName, // You can add here some description
                                    read:  true,
                                    write: false,
                                    state: 'state',
                                    role:  'value',
                                    type:  'number'
                                },
                                type: 'state',
                                _id: objectName
                            };
                            adapter.extendObject(objectName, stateObj);
                            objects[objectName] = true; //remember that we created the object.
                        }
                        adapter.setState(objectName, {
                            val: value,
                            ack: true
                        });
                    }
                } else {
                    value = rpi[i];
                    if (value !== undefined && value !== '' && value !== null) {
                        if (post.indexOf('$1') !== -1) {
                            adapter.log.debug('VALUE: ' + value + ' POST: ' + post);
                            try {
                                value = eval(post.replace('$1', value));
                            } catch (e) {
                                adapter.log.error('Cannot evaluate: ' + post.replace('$1', value));
                                value = NaN;
                            }
                        }
                        // TODO: Check if value is number and format it 2 Digits
                        if (!isNaN(value)) {
                            value = parseFloat(value);
                            const r = new RegExp(/^\d+\.\d+$/);
                            if (r.exec(value)) {
                                value = value.toFixed(2);
                            }
                        }

                        const objectName = adapter.name + '.' + adapter.instance + '.' + c + '.' + i;
                        adapter.log.debug('SETSTATE FOR ' + objectName + ' VALUE = ' + value);
                        if (objects[objectName] === undefined) {
                            // TODO Create an Objecttree
                            const stateObj = {
                                common: {
                                    name:  objectName, // You can add here some description
                                    read:  true,
                                    write: false,
                                    state: 'state',
                                    role:  'value',
                                    type:  'mixed'
                                },
                                type: 'state',
                                _id: objectName
                            };
                            adapter.extendObject(objectName, stateObj);
                            objects[objectName] = true; //remember that we created the object.
                        }
                        adapter.setState(objectName, {
                            val: value,
                            ack: true
                        });
                    } else {
                        if (i === 'wifi_send' || i === 'wifi_received') {
                            adapter.log.debug('No Value found for ' + i);
                        } else if (! errorsLogged[i]) {
                            adapter.log.error('No Value found for ' + i);
                            errorsLogged[i] = true;
                        }
                    }
                }
            }
        }
    }
}

function readValue(port) {
    if (!gpio) {
        return adapter.log.error('GPIO is not initialized!');
    }

    gpio.read(port, (err, value) => {
        if (err) {
            adapter.log.error('Cannot read port ' + port + ': ' + err);
        } else {
            adapter.setState('gpio.' + port + '.state', !!value, true);
        }
    });
}

function syncPort(port, data, callback) {
    adapter.getObject('gpio.' + port + '.state', (err, obj) => {
        if (data.enabled) {
            data.isButton = (data.input === 'button');
            data.isInput = (data.input === 'in' || data.input === 'true' || data.input === true || data.isButton);

            if (err || !obj || !obj.common) {
                obj = {
                    common: {
                        name:  'GPIO ' + port,
                        type:  'boolean',
                        role:  data.isInput ? 'indicator' : 'switch',
                        read:  data.isInput,
                        write: !data.isInput
                    },
                    native: {
                    },
                    type: 'state'
                };
                adapter.setObject('gpio.' + port + '.state', obj, () => {
                        syncPortDirection(port, data, callback);
                        syncPortButton(port, data, callback);
                    });
                } else {
                if (obj.common.read !== data.isInput) {
                    obj.common.read  = data.isInput;
                    obj.common.write = !data.isInput;
                    adapter.setObject('gpio.' + port + '.state', obj, () => {
                            syncPortDirection(port, data, callback);
                            syncPortButton(port, data, callback);
                        });
                    } else {
                    syncPortDirection(port, data, callback);
                    syncPortButton(port, data, callback);
                }
            }
        } else {
            if (obj && obj.common) {
                adapter.delObject('gpio.' + port + '.state', () =>
                    adapter.delState('gpio.' + port + '.state', () => {
                            syncPortDirection(port, data, callback);
                            syncPortButton(port, data, callback);
                        }));
            } else {
                syncPortDirection(port, data, callback);
                syncPortButton(port, data, callback);
            }
        }
    });
}

function syncPortDirection(port, data, callback) {
    adapter.getObject('gpio.' + port + '.isInput', (err, obj) => {
        if (data.enabled) {
            if (err || !obj || !obj.common) {
                obj = {
                    common: {
                        name:  'GPIO ' + port + ' direction',
                        type:  'boolean',
                        role:  'state',
                        read:  true,
                        write: false
                    },
                    native: {
                    },
                    type: 'state'
                };
                adapter.setObject('gpio.' + port + '.isInput', obj, () =>
                    adapter.setState('gpio.' + port + '.isInput', data.isInput, true, callback));
            } else {
                adapter.setState('gpio.' + port + '.isInput', data.isInput, true, callback);
            }
        } else {
            if (obj && obj.common) {
                adapter.delObject('gpio.' + port + '.isInput', () =>
                    adapter.delState('gpio.' + port + '.isInput', callback));
            } else {
                if (callback) callback();
            }
        }
    });
}

function syncPortButton(port, data, callback) {
    buttonEvents.forEach((eventName) => {
        const stateName = 'gpio.' + port + '.' + eventName;
        adapter.getObject(stateName, (err, obj) => {
            if (data.enabled && data.isButton) {
                if (err || !obj || !obj.common) {
                    obj = {
                        common: {
                            name:  'GPIO ' + port + ' ' + eventName,
                            type:  'boolean',
                            role:  'button',
                            read:  false,
                            write: true
                        },
                        native: {
                        },
                        type: 'state'
                    };
                    adapter.setObject(stateName, obj, callback);
                }
            } else {
                if (obj && obj.common) {
                    adapter.delObject(stateName, () =>
                        adapter.delState(stateName, callback));
                } else {
                    if (callback) callback();
                }
            }
        });
    });
}

function initPorts() {
    let anyGpioEnabled = false;
    let buttonPins = [];

    if (adapter.config.gpios && adapter.config.gpios.length) {
        for (let pp = 0; pp < adapter.config.gpios.length; pp++) {
            if (!adapter.config.gpios[pp] || !adapter.config.gpios[pp].enabled) continue;
            if (adapter.config.gpios[pp].input == 'button') {
                // This is a button - add to array to initialise module
                buttonPins.push(pp);
            } else {
                // Must just be regular GPIO
                anyGpioEnabled = true;
            }
        }
    }

    if (anyGpioEnabled) {
        try {
            gpio = require('rpi-gpio');
        } catch (e) {
            gpio = null;
            adapter.log.error('Cannot initialize GPIO: ' + e);
            console.error('Cannot initialize GPIO: ' + e);
        }
        try {
            gpio.setMode(gpio.MODE_BCM);
        } catch (e) {
            gpio = null;
            adapter.log.error('cannot use GPIO: ' + e);
        }
    }

    if (buttonPins.length > 0) {
        let gpioButtons;
        try {
            // TODO: Have global options for pull up/down, debounce timing, etc.
            const rpi_gpio_buttons = require('rpi-gpio-buttons');
            gpioButtons = rpi_gpio_buttons(buttonPins, { mode: rpi_gpio_buttons.MODE_BCM });
        } catch (e) {
            gpioButtons = null;
            adapter.log.error('Cannot initialize GPIO Buttons: ' + e);
        }
    }

    if (adapter.config.gpios && adapter.config.gpios.length) {
        let count = 0;
        for (let p = 0; p < adapter.config.gpios.length; p++) {

            if (!adapter.config.gpios[p]) continue;

            syncPort(p, adapter.config.gpios[p] || {});

            if (gpio && adapter.config.gpios[p].enabled) {
                /* Ensure backwards compatibility of property .input
                 * in older versions, it was true for "in" and false for "out" 
                 * in newer versions, it is "in", "out", "outlow" or "outhigh"
                 */
                if (adapter.config.gpios[p].input === 'true' || adapter.config.gpios[p].input === true) {
                    adapter.config.gpios[p].input = 'in';
                }
                else if (adapter.config.gpios[p].input === 'false' || adapter.config.gpios[p].input === false) {
                    adapter.config.gpios[p].input = 'out';
                }

                switch(adapter.config.gpios[p].input) {
                    case 'in':
                        count++;
                        (function (port){
                            gpio.setup(port, gpio.DIR_IN, gpio.EDGE_BOTH, err => {
                                if (!err) {
                                    readValue(port);
                                } else {
                                    adapter.log.error('Cannot setup port ' + port + ' as input: ' + err);
                                }
                                if (!--count) {
                                    adapter.log.debug('Register onchange handler');
                                    // register on change handler
                                    gpio.on('change', (port, value) => {
                                        adapter.log.debug('GPIO change on port ' + port + ': ' + value);
                                        adapter.setState('gpio.' + port + '.state', !!value, true);
                                    });
                                }
                            });
                        })(p);
                        break;
                    case 'out':
                        (function (port){
                            gpio.setup(port, gpio.DIR_OUT, err =>
                                err && adapter.log.error('Cannot setup port ' + port + ' as output: ' + err));
                        })(p);
                        break;
                    case 'outlow':
                        (function (port){
                            gpio.setup(port, gpio.DIR_LOW, err =>
                                err && adapter.log.error('Cannot setup port ' + port + ' as output with initial value "0": ' + err));
                        })(p);
                        break;
                    case 'outhigh':
                        (function (port){
                            gpio.setup(port, gpio.DIR_HIGH, err =>
                                err && adapter.log.error('Cannot setup port ' + port + ' as output with initial value "1": ' + err));
                        })(p);
                        break;
                    default:
                        adapter.log.error('Cannot setup port ' + port + ': invalid direction type.');
                }
            }
        }
    } else {
        adapter.log.info('GPIO ports are not configured');
    }
}
