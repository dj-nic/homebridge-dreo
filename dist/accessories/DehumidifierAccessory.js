"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DehumidifierAccessory = void 0;
const BaseAccessory_1 = require("./BaseAccessory");
class DehumidifierAccessory extends BaseAccessory_1.BaseAccessory {
    constructor(platform, accessory, state) {
        super(platform, accessory);
        this.COMMAND_DEBOUNCE_MS = 600;
        this.HUMIDITY_MIN = 30;
        this.HUMIDITY_MAX = 85;
        this.HUMIDITY_DEFAULT = 50;
        this.MODE_AUTO = 1;
        this.MODE_CONTINUOUS = 2;
        this.currState = {
            on: false,
            humidity: this.HUMIDITY_DEFAULT,
            targetHumidity: this.HUMIDITY_DEFAULT,
            mode: this.MODE_AUTO,
            fanLevel: 1,
            maxFanLevel: 3,
            displayLight: false,
            panelSound: true,
            autoOn: false,
            temperature: undefined,
        };
        this.initializeStateFromSnapshot(state);
        this.supportsWindLevel = state.windlevel !== undefined;
        const deviceName = accessory.context.device.deviceName || 'Dehumidifier';
        this.humidifierService =
            this.accessory.getService(this.platform.Service.HumidifierDehumidifier) ||
                this.accessory.addService(this.platform.Service.HumidifierDehumidifier, deviceName);
        this.humiditySensor =
            this.accessory.getService(this.platform.Service.HumiditySensor) ||
                this.accessory.addService(this.platform.Service.HumiditySensor, 'Current Humidity');
        this.configureHumidifierService(deviceName);
        this.configureAuxiliaryServices(state, deviceName);
        this.refreshInitialCharacteristics();
        this.registerWebSocketListener();
    }
    initializeStateFromSnapshot(state) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r;
        this.currState.on = this.toBoolean((_b = (_a = state.poweron) === null || _a === void 0 ? void 0 : _a.state) !== null && _b !== void 0 ? _b : false);
        this.currState.mode = (_d = this.toNumber((_c = state.mode) === null || _c === void 0 ? void 0 : _c.state)) !== null && _d !== void 0 ? _d : this.MODE_AUTO;
        this.currState.humidity = this.normalizeHumidity((_f = (_e = state.rh) === null || _e === void 0 ? void 0 : _e.state) !== null && _f !== void 0 ? _f : (_g = state.humidity) === null || _g === void 0 ? void 0 : _g.state);
        this.currState.targetHumidity = this.clampTargetHumidity((_h = state.rhautolevel) === null || _h === void 0 ? void 0 : _h.state);
        this.currState.maxFanLevel = this.determineMaxFanLevel(state);
        this.currState.fanLevel = this.toValidFanLevel(this.toNumber((_j = state.windlevel) === null || _j === void 0 ? void 0 : _j.state));
        this.currState.displayLight = this.toBoolean((_l = (_k = state.lighton) === null || _k === void 0 ? void 0 : _k.state) !== null && _l !== void 0 ? _l : false);
        this.currState.panelSound = !this.toBoolean((_o = (_m = state.muteon) === null || _m === void 0 ? void 0 : _m.state) !== null && _o !== void 0 ? _o : false);
        this.currState.autoOn = this.toBoolean((_q = (_p = state.autoon) === null || _p === void 0 ? void 0 : _p.state) !== null && _q !== void 0 ? _q : this.currState.mode === this.MODE_AUTO);
        this.currState.temperature = this.toTemperature((_r = state.temperature) === null || _r === void 0 ? void 0 : _r.state);
    }
    configureHumidifierService(deviceName) {
        this.humidifierService.setCharacteristic(this.platform.Characteristic.Name, deviceName);
        this.humidifierService
            .getCharacteristic(this.platform.Characteristic.Active)
            .onSet(this.setActive.bind(this))
            .onGet(this.getActive.bind(this));
        this.humidifierService
            .getCharacteristic(this.platform.Characteristic.CurrentHumidifierDehumidifierState)
            .setProps({
            minValue: 0,
            maxValue: 3,
            validValues: [
                this.platform.Characteristic.CurrentHumidifierDehumidifierState.INACTIVE,
                this.platform.Characteristic.CurrentHumidifierDehumidifierState.IDLE,
                this.platform.Characteristic.CurrentHumidifierDehumidifierState.DEHUMIDIFYING,
            ],
        })
            .onGet(this.getCurrentDehumidifierState.bind(this));
        this.humidifierService
            .getCharacteristic(this.platform.Characteristic.RelativeHumidityDehumidifierThreshold)
            .setProps({
            minValue: this.HUMIDITY_MIN,
            maxValue: this.HUMIDITY_MAX,
            minStep: 1,
        })
            .onSet(this.setTargetHumidity.bind(this))
            .onGet(this.getTargetHumidity.bind(this));
        // Home sometimes uses the HUMIDIFIER threshold in AUTOMATIC mode.
        // Keep both thresholds in sync to prevent the slider from snapping back or showing 0%.
        this.humidifierService
            .getCharacteristic(this.platform.Characteristic.RelativeHumidityHumidifierThreshold)
            .setProps({
            minValue: this.HUMIDITY_MIN,
            maxValue: this.HUMIDITY_MAX,
            minStep: 1,
        })
            .onSet(this.setTargetHumidity.bind(this))
            .onGet(this.getTargetHumidity.bind(this));
        this.humidifierService
            .getCharacteristic(this.platform.Characteristic.TargetHumidifierDehumidifierState)
            .setProps({
            minValue: this.platform.Characteristic.TargetHumidifierDehumidifierState.HUMIDIFIER_OR_DEHUMIDIFIER,
            maxValue: this.platform.Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER,
            validValues: [
                this.platform.Characteristic.TargetHumidifierDehumidifierState.HUMIDIFIER_OR_DEHUMIDIFIER,
                this.platform.Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER,
            ],
        })
            .onSet(this.setTargetHumidifierDehumidifierState.bind(this))
            .onGet(this.getTargetHumidifierDehumidifierState.bind(this));
        this.humidifierService
            .getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
            .onGet(this.getCurrentHumidity.bind(this));
        this.humiditySensor
            .getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
            .onGet(this.getCurrentHumidity.bind(this));
        if (this.supportsWindLevel) {
            const step = 100 / this.currState.maxFanLevel;
            this.humidifierService
                .getCharacteristic(this.platform.Characteristic.RotationSpeed)
                .setProps({
                minValue: 0,
                maxValue: 100,
                minStep: step,
            })
                .onSet(this.setRotationSpeed.bind(this))
                .onGet(this.getRotationSpeed.bind(this));
        }
    }
    configureAuxiliaryServices(state, deviceName) {
        var _a, _b, _c;
        const existingTemperatureService = this.accessory.getService(this.platform.Service.TemperatureSensor);
        const hideTemperatureSensor = (_a = this.platform.config.hideTemperatureSensor) !== null && _a !== void 0 ? _a : false;
        if (!hideTemperatureSensor && state.temperature !== undefined) {
            this.temperatureSensor = existingTemperatureService ||
                this.accessory.addService(this.platform.Service.TemperatureSensor, 'Temperature Sensor');
            this.temperatureSensor
                .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
                .onGet(this.getCurrentTemperature.bind(this));
        }
        else if (hideTemperatureSensor && existingTemperatureService) {
            this.accessory.removeService(existingTemperatureService);
        }
        const existingTargetHumidityService = this.accessory.getServiceById(this.platform.Service.HumiditySensor, 'TargetHumidity');
        const hideTargetHumiditySensor = (_b = this.platform.config.hideTargetHumiditySensor) !== null && _b !== void 0 ? _b : true;
        if (!hideTargetHumiditySensor) {
            this.targetHumiditySensor = existingTargetHumidityService ||
                this.accessory.addService(this.platform.Service.HumiditySensor, 'Target Humidity', 'TargetHumidity');
            this.targetHumiditySensor
                .setCharacteristic(this.platform.Characteristic.Name, 'Target Humidity')
                .updateCharacteristic(this.platform.Characteristic.Name, 'Target Humidity');
            this.targetHumiditySensor
                .getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
                .onGet(this.getTargetHumidity.bind(this));
        }
        else if (hideTargetHumiditySensor && existingTargetHumidityService) {
            this.accessory.removeService(existingTargetHumidityService);
        }
        const existingModeSwitch = this.accessory.getServiceById(this.platform.Service.Switch, 'ContinuousMode');
        if (existingModeSwitch) {
            this.accessory.removeService(existingModeSwitch);
        }
        const existingPanelSoundSwitch = this.accessory.getServiceById(this.platform.Service.Switch, 'PanelSound');
        const hidePanelSoundSwitch = (_c = this.platform.config.hidePanelSoundSwitch) !== null && _c !== void 0 ? _c : true;
        if (state.muteon !== undefined && !hidePanelSoundSwitch) {
            this.panelSoundSwitch = existingPanelSoundSwitch ||
                this.accessory.addService(this.platform.Service.Switch, 'Panel Sound', 'PanelSound');
            this.panelSoundSwitch
                .setCharacteristic(this.platform.Characteristic.Name, 'Panel Sound')
                .updateCharacteristic(this.platform.Characteristic.Name, 'Panel Sound');
            this.panelSoundSwitch
                .getCharacteristic(this.platform.Characteristic.On)
                .onSet(this.setPanelSound.bind(this))
                .onGet(this.getPanelSound.bind(this));
        }
        else if (hidePanelSoundSwitch && existingPanelSoundSwitch) {
            this.accessory.removeService(existingPanelSoundSwitch);
        }
        if (state.lighton !== undefined) {
            this.displayLightSwitch = this.accessory.getServiceById(this.platform.Service.Switch, 'DisplayLight') ||
                this.accessory.addService(this.platform.Service.Switch, `${deviceName} Display`, 'DisplayLight');
            this.displayLightSwitch
                .setCharacteristic(this.platform.Characteristic.Name, 'Display Light')
                .updateCharacteristic(this.platform.Characteristic.Name, 'Display Light');
            this.displayLightSwitch
                .getCharacteristic(this.platform.Characteristic.On)
                .onSet(this.setDisplayLight.bind(this))
                .onGet(this.getDisplayLight.bind(this));
        }
    }
    refreshInitialCharacteristics() {
        var _a, _b, _c;
        this.humidifierService
            .getCharacteristic(this.platform.Characteristic.Active)
            .updateValue(this.currState.on);
        this.humidifierService
            .getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
            .updateValue(this.currState.humidity);
        this.humiditySensor
            .getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
            .updateValue(this.currState.humidity);
        this.humidifierService
            .getCharacteristic(this.platform.Characteristic.RelativeHumidityDehumidifierThreshold)
            .updateValue(this.currState.targetHumidity);
        this.humidifierService
            .getCharacteristic(this.platform.Characteristic.RelativeHumidityHumidifierThreshold)
            .updateValue(this.currState.targetHumidity);
        (_a = this.targetHumiditySensor) === null || _a === void 0 ? void 0 : _a.getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity).updateValue(this.currState.targetHumidity);
        if (this.supportsWindLevel) {
            this.humidifierService
                .getCharacteristic(this.platform.Characteristic.RotationSpeed)
                .updateValue(this.getRotationSpeed());
        }
        (_b = this.panelSoundSwitch) === null || _b === void 0 ? void 0 : _b.getCharacteristic(this.platform.Characteristic.On).updateValue(this.getPanelSound());
        (_c = this.displayLightSwitch) === null || _c === void 0 ? void 0 : _c.getCharacteristic(this.platform.Characteristic.On).updateValue(this.getDisplayLight());
        if (this.temperatureSensor && this.currState.temperature !== undefined) {
            this.temperatureSensor
                .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
                .updateValue(this.getCurrentTemperature());
        }
        this.updateCurrentStateCharacteristic();
    }
    registerWebSocketListener() {
        this.platform.webHelper.addEventListener('message', (message) => {
            var _a;
            let data;
            try {
                data = JSON.parse(message.data);
            }
            catch (error) {
                this.platform.log.error('Failed to parse incoming message: %s', error);
                return;
            }
            if (data.devicesn !== this.sn) {
                return;
            }
            if (!['control-report', 'control-reply', 'report'].includes(data.method)) {
                return;
            }
            const reported = (_a = data.reported) !== null && _a !== void 0 ? _a : {};
            Object.entries(reported).forEach(([key, value]) => {
                this.handleIncomingUpdate(key, value);
            });
        });
    }
    handleIncomingUpdate(key, value) {
        var _a, _b, _c, _d, _e;
        switch (key) {
            case 'poweron':
                this.currState.on = this.toBoolean(value);
                this.humidifierService
                    .getCharacteristic(this.platform.Characteristic.Active)
                    .updateValue(this.currState.on);
                this.updateCurrentStateCharacteristic();
                break;
            case 'rh':
            case 'humidity':
                this.currState.humidity = this.normalizeHumidity(value);
                this.updateHumidityCharacteristics();
                this.updateCurrentStateCharacteristic();
                break;
            case 'rhautolevel':
                this.currState.targetHumidity = this.clampTargetHumidity(value);
                this.humidifierService
                    .getCharacteristic(this.platform.Characteristic.RelativeHumidityDehumidifierThreshold)
                    .updateValue(this.currState.targetHumidity);
                this.humidifierService
                    .getCharacteristic(this.platform.Characteristic.RelativeHumidityHumidifierThreshold)
                    .updateValue(this.currState.targetHumidity);
                (_a = this.targetHumiditySensor) === null || _a === void 0 ? void 0 : _a.getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity).updateValue(this.currState.targetHumidity);
                this.updateCurrentStateCharacteristic();
                break;
            case 'windlevel':
                if (this.supportsWindLevel) {
                    this.currState.fanLevel = this.toValidFanLevel(this.toNumber(value));
                    this.humidifierService
                        .getCharacteristic(this.platform.Characteristic.RotationSpeed)
                        .updateValue(this.getRotationSpeed());
                }
                break;
            case 'mode':
                this.currState.mode = (_b = this.toNumber(value)) !== null && _b !== void 0 ? _b : this.currState.mode;
                this.humidifierService
                    .getCharacteristic(this.platform.Characteristic.TargetHumidifierDehumidifierState)
                    .updateValue(this.getTargetHumidifierDehumidifierState());
                this.updateCurrentStateCharacteristic();
                break;
            case 'lighton':
                this.currState.displayLight = this.toBoolean(value);
                (_c = this.displayLightSwitch) === null || _c === void 0 ? void 0 : _c.getCharacteristic(this.platform.Characteristic.On).updateValue(this.currState.displayLight);
                break;
            case 'muteon':
                this.currState.panelSound = !this.toBoolean(value);
                (_d = this.panelSoundSwitch) === null || _d === void 0 ? void 0 : _d.getCharacteristic(this.platform.Characteristic.On).updateValue(this.currState.panelSound);
                break;
            case 'autoon':
                this.currState.autoOn = this.toBoolean(value);
                break;
            case 'temperature':
                this.currState.temperature = this.toTemperature(value);
                (_e = this.temperatureSensor) === null || _e === void 0 ? void 0 : _e.getCharacteristic(this.platform.Characteristic.CurrentTemperature).updateValue(this.getCurrentTemperature());
                break;
            default:
                this.platform.log.debug('Unhandled update key for %s: %s', this.sn, key);
        }
    }
    updateHumidityCharacteristics() {
        const humidity = this.getCurrentHumidity();
        this.humidifierService
            .getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
            .updateValue(humidity);
        this.humiditySensor
            .getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
            .updateValue(humidity);
    }
    updateCurrentStateCharacteristic() {
        this.humidifierService
            .getCharacteristic(this.platform.Characteristic.CurrentHumidifierDehumidifierState)
            .updateValue(this.getCurrentDehumidifierState());
    }
    toBoolean(value) {
        if (typeof value === 'boolean') {
            return value;
        }
        if (typeof value === 'number') {
            return value !== 0;
        }
        if (typeof value === 'string') {
            return value !== '0' && value.toLowerCase() !== 'false';
        }
        return Boolean(value);
    }
    toNumber(value) {
        if (value === undefined) {
            return undefined;
        }
        const num = Number(value);
        return Number.isFinite(num) ? num : undefined;
    }
    normalizeHumidity(value) {
        const num = this.toNumber(value);
        if (num === undefined) {
            return this.HUMIDITY_DEFAULT;
        }
        const rounded = Math.round(num);
        return Math.min(100, Math.max(0, rounded));
    }
    clampTargetHumidity(value) {
        const num = this.toNumber(value);
        if (num === undefined) {
            return this.HUMIDITY_DEFAULT;
        }
        // HomeKit clients should respect min/max props, but iOS sometimes sends values as a
        // delta within the configured range (e.g. 0..(max-min)) after prop changes/caching.
        // Example: with 30..85, iOS may send 0..55. Translate those to absolute percent.
        let rounded = Math.round(num);
        const span = this.HUMIDITY_MAX - this.HUMIDITY_MIN;
        if (rounded >= 0 && rounded <= span && rounded < this.HUMIDITY_MIN) {
            rounded = this.HUMIDITY_MIN + rounded;
        }
        return Math.min(this.HUMIDITY_MAX, Math.max(this.HUMIDITY_MIN, rounded));
    }
    determineMaxFanLevel(state) {
        var _a, _b, _c, _d, _e;
        const stateMax = this.toNumber((_a = state.windlevel) === null || _a === void 0 ? void 0 : _a.max);
        if (stateMax !== undefined && stateMax > 0) {
            return Math.max(1, Math.round(stateMax));
        }
        const controls = (_b = this.accessory.context.device.controlsConf) === null || _b === void 0 ? void 0 : _b.control;
        if (Array.isArray(controls)) {
            for (const control of controls) {
                const type = ((_c = control === null || control === void 0 ? void 0 : control.type) !== null && _c !== void 0 ? _c : '').toString().toLowerCase();
                if (type.includes('speed') || type.includes('wind')) {
                    const items = Array.isArray(control === null || control === void 0 ? void 0 : control.items) ? control.items : [];
                    const candidate = items[items.length - 1];
                    const candidateObj = candidate;
                    const extracted = Number((_e = (_d = candidateObj === null || candidateObj === void 0 ? void 0 : candidateObj.value) !== null && _d !== void 0 ? _d : candidateObj === null || candidateObj === void 0 ? void 0 : candidateObj.text) !== null && _e !== void 0 ? _e : candidate);
                    if (!Number.isNaN(extracted) && extracted > 0) {
                        return Math.max(1, Math.round(extracted));
                    }
                }
            }
        }
        return 3;
    }
    toValidFanLevel(value) {
        if (!value || value <= 0) {
            return 1;
        }
        const max = Math.max(1, this.currState.maxFanLevel);
        return Math.min(max, Math.max(1, Math.round(value)));
    }
    toTemperature(value) {
        const num = this.toNumber(value);
        if (num === undefined) {
            return undefined;
        }
        if (num > 45) {
            return Math.round(((num - 32) * 5) / 9 * 10) / 10;
        }
        return Math.round(num * 10) / 10;
    }
    getRotationSpeedValue() {
        const percent = (this.currState.fanLevel / this.currState.maxFanLevel) * 100;
        return Math.max(0, Math.min(100, Math.round(percent)));
    }
    getCurrentDehumidifierState() {
        if (!this.currState.on) {
            return this.platform.Characteristic.CurrentHumidifierDehumidifierState.INACTIVE;
        }
        if (this.currState.humidity <= this.currState.targetHumidity) {
            return this.platform.Characteristic.CurrentHumidifierDehumidifierState.IDLE;
        }
        return this.platform.Characteristic.CurrentHumidifierDehumidifierState.DEHUMIDIFYING;
    }
    getCurrentHumidity() {
        return this.currState.humidity;
    }
    getTargetHumidity() {
        return this.currState.targetHumidity;
    }
    getCurrentTemperature() {
        var _a;
        return (_a = this.currState.temperature) !== null && _a !== void 0 ? _a : 0;
    }
    getRotationSpeed() {
        return this.getRotationSpeedValue();
    }
    getTargetHumidifierDehumidifierState() {
        // Map device mode to HomeKit dropdown.
        // - Auto => AUTOMATIC (0)
        // - Continuous => DEHUMIDIFIER (2)
        return this.currState.mode === this.MODE_CONTINUOUS
            ? this.platform.Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER
            : this.platform.Characteristic.TargetHumidifierDehumidifierState.HUMIDIFIER_OR_DEHUMIDIFIER;
    }
    getPanelSound() {
        return this.currState.panelSound;
    }
    getDisplayLight() {
        return this.currState.displayLight;
    }
    setActive(value) {
        const isActive = this.toBoolean(value);
        if (this.currState.on === isActive) {
            return;
        }
        this.currState.on = isActive;
        this.humidifierService
            .getCharacteristic(this.platform.Characteristic.Active)
            .updateValue(this.currState.on);
        this.platform.webHelper.control(this.sn, { poweron: isActive });
        this.updateCurrentStateCharacteristic();
    }
    getActive() {
        return this.currState.on;
    }
    setTargetHumidifierDehumidifierState(value) {
        const numeric = this.toNumber(value);
        if (numeric === undefined) {
            return;
        }
        let nextMode;
        if (numeric === this.platform.Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER) {
            nextMode = this.MODE_CONTINUOUS;
        }
        else if (numeric === this.platform.Characteristic.TargetHumidifierDehumidifierState.HUMIDIFIER_OR_DEHUMIDIFIER) {
            nextMode = this.MODE_AUTO;
        }
        else {
            return;
        }
        if (this.currState.mode === nextMode) {
            return;
        }
        this.currState.mode = nextMode;
        const command = { mode: nextMode };
        if (!this.currState.on) {
            this.currState.on = true;
            command.poweron = true;
            this.humidifierService
                .getCharacteristic(this.platform.Characteristic.Active)
                .updateValue(this.currState.on);
        }
        this.humidifierService
            .getCharacteristic(this.platform.Characteristic.TargetHumidifierDehumidifierState)
            .updateValue(this.getTargetHumidifierDehumidifierState());
        this.platform.webHelper.control(this.sn, command);
        this.updateCurrentStateCharacteristic();
    }
    setTargetHumidity(value) {
        var _a;
        const humidity = this.clampTargetHumidity(value);
        this.currState.targetHumidity = humidity;
        this.humidifierService
            .getCharacteristic(this.platform.Characteristic.RelativeHumidityDehumidifierThreshold)
            .updateValue(humidity);
        this.humidifierService
            .getCharacteristic(this.platform.Characteristic.RelativeHumidityHumidifierThreshold)
            .updateValue(humidity);
        (_a = this.targetHumiditySensor) === null || _a === void 0 ? void 0 : _a.getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity).updateValue(humidity);
        // Target humidity is only meaningful in Auto mode for many devices.
        // If the user adjusts the slider, ensure the device is on and in Auto.
        if (!this.currState.on) {
            this.currState.on = true;
            this.humidifierService
                .getCharacteristic(this.platform.Characteristic.Active)
                .updateValue(this.currState.on);
        }
        if (this.currState.mode !== this.MODE_AUTO) {
            this.currState.mode = this.MODE_AUTO;
            this.humidifierService
                .getCharacteristic(this.platform.Characteristic.TargetHumidifierDehumidifierState)
                .updateValue(this.getTargetHumidifierDehumidifierState());
        }
        this.scheduleTargetHumidityCommand(humidity);
        this.updateCurrentStateCharacteristic();
    }
    setRotationSpeed(value) {
        var _a;
        const numeric = (_a = this.toNumber(value)) !== null && _a !== void 0 ? _a : 0;
        if (numeric <= 0) {
            if (this.fanSpeedDebounceTimer) {
                clearTimeout(this.fanSpeedDebounceTimer);
                this.fanSpeedDebounceTimer = undefined;
            }
            this.setActive(false);
            return;
        }
        const converted = Math.max(1, Math.min(this.currState.maxFanLevel, Math.round((numeric * this.currState.maxFanLevel) / 100)));
        this.currState.fanLevel = converted;
        if (!this.currState.on) {
            this.currState.on = true;
            this.humidifierService
                .getCharacteristic(this.platform.Characteristic.Active)
                .updateValue(this.currState.on);
        }
        this.updateCurrentStateCharacteristic();
        this.humidifierService
            .getCharacteristic(this.platform.Characteristic.RotationSpeed)
            .updateValue(this.getRotationSpeed());
        this.scheduleFanSpeedCommand(converted);
    }
    scheduleTargetHumidityCommand(value) {
        this.pendingTargetHumidity = value;
        if (this.targetHumidityDebounceTimer) {
            clearTimeout(this.targetHumidityDebounceTimer);
        }
        this.targetHumidityDebounceTimer = setTimeout(() => {
            if (this.pendingTargetHumidity !== undefined) {
                this.platform.webHelper.control(this.sn, {
                    poweron: true,
                    mode: this.MODE_AUTO,
                    rhautolevel: this.pendingTargetHumidity,
                });
            }
            this.targetHumidityDebounceTimer = undefined;
        }, this.COMMAND_DEBOUNCE_MS);
    }
    scheduleFanSpeedCommand(level) {
        this.pendingFanLevel = level;
        if (this.fanSpeedDebounceTimer) {
            clearTimeout(this.fanSpeedDebounceTimer);
        }
        this.fanSpeedDebounceTimer = setTimeout(() => {
            if (this.pendingFanLevel !== undefined) {
                this.platform.webHelper.control(this.sn, {
                    poweron: true,
                    windlevel: this.pendingFanLevel,
                });
            }
            this.fanSpeedDebounceTimer = undefined;
        }, this.COMMAND_DEBOUNCE_MS);
    }
    setPanelSound(value) {
        var _a;
        const enabled = this.toBoolean(value);
        this.currState.panelSound = enabled;
        (_a = this.panelSoundSwitch) === null || _a === void 0 ? void 0 : _a.getCharacteristic(this.platform.Characteristic.On).updateValue(enabled);
        this.platform.webHelper.control(this.sn, { muteon: !enabled });
    }
    setDisplayLight(value) {
        var _a;
        const enabled = this.toBoolean(value);
        this.currState.displayLight = enabled;
        (_a = this.displayLightSwitch) === null || _a === void 0 ? void 0 : _a.getCharacteristic(this.platform.Characteristic.On).updateValue(enabled);
        this.platform.webHelper.control(this.sn, { lighton: enabled });
    }
}
exports.DehumidifierAccessory = DehumidifierAccessory;
//# sourceMappingURL=DehumidifierAccessory.js.map