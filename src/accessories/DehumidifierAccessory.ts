import { PlatformAccessory, Service } from 'homebridge';
import { DreoPlatform } from '../platform';
import { BaseAccessory } from './BaseAccessory';

interface DreoBooleanState {
  state: boolean | number | string;
}

interface DreoNumericState {
  state: number | string;
  max?: number | string;
  min?: number | string;
}

interface DreoDehumidifierState {
  poweron?: DreoBooleanState;
  mode?: DreoNumericState;
  rh?: DreoNumericState;
  humidity?: DreoNumericState;
  rhautolevel?: DreoNumericState;
  windlevel?: DreoNumericState;
  childlockon?: DreoBooleanState;
  lighton?: DreoBooleanState;
  muteon?: DreoBooleanState;
  autoon?: DreoBooleanState;
  temperature?: DreoNumericState;
}

type RawReportedValue = string | number | boolean | undefined;

type ContinuousMode = 1 | 2;

export class DehumidifierAccessory extends BaseAccessory {
  private readonly humidifierService: Service;
  private readonly humiditySensor: Service;
  private temperatureSensor?: Service;
  private modeSwitch?: Service;
  private panelSoundSwitch?: Service;
  private displayLightSwitch?: Service;
  private readonly supportsWindLevel: boolean;
  private readonly supportsChildLock: boolean;

  private readonly HUMIDITY_MIN = 30;
  private readonly HUMIDITY_MAX = 85;
  private readonly HUMIDITY_DEFAULT = 50;
  private readonly MODE_AUTO: ContinuousMode = 1;
  private readonly MODE_CONTINUOUS: ContinuousMode = 2;

  private currState = {
    on: false,
    humidity: this.HUMIDITY_DEFAULT,
    targetHumidity: this.HUMIDITY_DEFAULT,
    mode: this.MODE_AUTO as ContinuousMode,
    fanLevel: 1,
    maxFanLevel: 3,
    childLock: false,
    displayLight: false,
    panelSound: true,
    autoOn: false,
    temperature: undefined as number | undefined,
  };

  constructor(
    platform: DreoPlatform,
    accessory: PlatformAccessory,
    state: DreoDehumidifierState,
  ) {
    super(platform, accessory);

    this.initializeStateFromSnapshot(state);
    this.supportsWindLevel = state.windlevel !== undefined;
    this.supportsChildLock = state.childlockon !== undefined;

    const deviceName = accessory.context.device.deviceName || 'Dehumidifier';

    this.humidifierService =
      this.accessory.getService(this.platform.Service.HumidifierDehumidifier) ||
      this.accessory.addService(this.platform.Service.HumidifierDehumidifier, deviceName);

    this.humiditySensor =
      this.accessory.getService(this.platform.Service.HumiditySensor) ||
      this.accessory.addService(this.platform.Service.HumiditySensor, 'Humidity Sensor');

    this.configureHumidifierService(deviceName, state);
    this.configureAuxiliaryServices(state, deviceName);
    this.refreshInitialCharacteristics();
    this.registerWebSocketListener();
  }

  private initializeStateFromSnapshot(state: DreoDehumidifierState) {
    this.currState.on = this.toBoolean(state.poweron?.state ?? false);
    this.currState.mode = (this.toNumber(state.mode?.state) as ContinuousMode) ?? this.MODE_AUTO;
  this.currState.humidity = this.normalizeHumidity(state.rh?.state ?? state.humidity?.state);
  this.currState.targetHumidity = this.clampTargetHumidity(state.rhautolevel?.state);
  this.currState.maxFanLevel = this.determineMaxFanLevel(state);
  this.currState.fanLevel = this.toValidFanLevel(this.toNumber(state.windlevel?.state));
    this.currState.childLock = this.toBoolean(state.childlockon?.state ?? false);
    this.currState.displayLight = this.toBoolean(state.lighton?.state ?? false);
    this.currState.panelSound = !this.toBoolean(state.muteon?.state ?? false);
    this.currState.autoOn = this.toBoolean(state.autoon?.state ?? this.currState.mode === this.MODE_AUTO);
    this.currState.temperature = this.toTemperature(state.temperature?.state);
  }

  private configureHumidifierService(deviceName: string, snapshot: DreoDehumidifierState) {
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
      .getCharacteristic(this.platform.Characteristic.TargetHumidifierDehumidifierState)
      .setProps({
        minValue: this.platform.Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER,
        maxValue: this.platform.Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER,
        validValues: [this.platform.Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER],
      })
      .onSet(() => {
        // HomeKit requires a handler even if the value is fixed
        return;
      })
      .onGet(() => this.platform.Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER);

    this.humidifierService
      .getCharacteristic(this.platform.Characteristic.RelativeHumidityDehumidifierThreshold)
      .setProps({
        minValue: this.HUMIDITY_MIN,
        maxValue: this.HUMIDITY_MAX,
        minStep: 1,
      })
      .onSet(this.setTargetHumidity.bind(this))
      .onGet(this.getTargetHumidity.bind(this));

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

  if (this.supportsChildLock) {
      this.humidifierService
        .getCharacteristic(this.platform.Characteristic.LockPhysicalControls)
        .onSet(this.setChildLock.bind(this))
        .onGet(this.getChildLock.bind(this));
    }
  }

  private configureAuxiliaryServices(state: DreoDehumidifierState, deviceName: string) {
    const existingTemperatureService = this.accessory.getService(this.platform.Service.TemperatureSensor);
    const hideTemperatureSensor = this.platform.config.hideTemperatureSensor || false;

    if (!hideTemperatureSensor && state.temperature !== undefined) {
      this.temperatureSensor = existingTemperatureService ||
        this.accessory.addService(this.platform.Service.TemperatureSensor, 'Temperature Sensor');

      this.temperatureSensor
        .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
        .onGet(this.getCurrentTemperature.bind(this));
    } else if (hideTemperatureSensor && existingTemperatureService) {
      this.accessory.removeService(existingTemperatureService);
    }

    if (state.mode !== undefined) {
      this.modeSwitch = this.accessory.getServiceById(this.platform.Service.Switch, 'ContinuousMode') ||
        this.accessory.addService(this.platform.Service.Switch, 'Continuous Mode', 'ContinuousMode');
      this.modeSwitch
        .getCharacteristic(this.platform.Characteristic.On)
        .onSet(this.setContinuousMode.bind(this))
        .onGet(this.getContinuousMode.bind(this));
    }

    if (state.muteon !== undefined) {
      this.panelSoundSwitch = this.accessory.getServiceById(this.platform.Service.Switch, 'PanelSound') ||
        this.accessory.addService(this.platform.Service.Switch, 'Panel Sound', 'PanelSound');
      this.panelSoundSwitch
        .getCharacteristic(this.platform.Characteristic.On)
        .onSet(this.setPanelSound.bind(this))
        .onGet(this.getPanelSound.bind(this));
    }

    if (state.lighton !== undefined) {
      this.displayLightSwitch = this.accessory.getServiceById(this.platform.Service.Switch, 'DisplayLight') ||
        this.accessory.addService(this.platform.Service.Switch, `${deviceName} Display`, 'DisplayLight');
      this.displayLightSwitch
        .getCharacteristic(this.platform.Characteristic.On)
        .onSet(this.setDisplayLight.bind(this))
        .onGet(this.getDisplayLight.bind(this));
    }
  }

  private refreshInitialCharacteristics() {
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
    if (this.supportsWindLevel) {
      this.humidifierService
        .getCharacteristic(this.platform.Characteristic.RotationSpeed)
        .updateValue(this.getRotationSpeed());
    }
    if (this.supportsChildLock) {
      this.humidifierService
        .getCharacteristic(this.platform.Characteristic.LockPhysicalControls)
        .updateValue(this.getChildLock());
    }
    this.modeSwitch?.getCharacteristic(this.platform.Characteristic.On)
      .updateValue(this.getContinuousMode());
    this.panelSoundSwitch?.getCharacteristic(this.platform.Characteristic.On)
      .updateValue(this.getPanelSound());
    this.displayLightSwitch?.getCharacteristic(this.platform.Characteristic.On)
      .updateValue(this.getDisplayLight());
    if (this.temperatureSensor && this.currState.temperature !== undefined) {
      this.temperatureSensor
        .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
        .updateValue(this.getCurrentTemperature());
    }
    this.updateCurrentStateCharacteristic();
  }

  private registerWebSocketListener() {
    this.platform.webHelper.addEventListener('message', (message) => {
      let data;
      try {
        data = JSON.parse(message.data);
      } catch (error) {
        this.platform.log.error('Failed to parse incoming message: %s', error);
        return;
      }

      if (data.devicesn !== this.sn) {
        return;
      }

      if (!['control-report', 'control-reply', 'report'].includes(data.method)) {
        return;
      }

      const reported = data.reported ?? {};
      Object.entries(reported).forEach(([key, value]) => {
        this.handleIncomingUpdate(key, value as RawReportedValue);
      });
    });
  }

  private handleIncomingUpdate(key: string, value: RawReportedValue) {
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
        this.currState.mode = (this.toNumber(value) as ContinuousMode) ?? this.currState.mode;
        this.modeSwitch?.getCharacteristic(this.platform.Characteristic.On)
          .updateValue(this.getContinuousMode());
        this.updateCurrentStateCharacteristic();
        break;
      case 'childlockon':
        if (this.supportsChildLock) {
          this.currState.childLock = this.toBoolean(value);
          this.humidifierService
            .getCharacteristic(this.platform.Characteristic.LockPhysicalControls)
            .updateValue(this.getChildLock());
        }
        break;
      case 'lighton':
        this.currState.displayLight = this.toBoolean(value);
        this.displayLightSwitch?.getCharacteristic(this.platform.Characteristic.On)
          .updateValue(this.currState.displayLight);
        break;
      case 'muteon':
        this.currState.panelSound = !this.toBoolean(value);
        this.panelSoundSwitch?.getCharacteristic(this.platform.Characteristic.On)
          .updateValue(this.currState.panelSound);
        break;
      case 'autoon':
        this.currState.autoOn = this.toBoolean(value);
        break;
      case 'temperature':
        this.currState.temperature = this.toTemperature(value);
        this.temperatureSensor?.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
          .updateValue(this.getCurrentTemperature());
        break;
      default:
        this.platform.log.debug('Unhandled update key for %s: %s', this.sn, key);
    }
  }

  private updateHumidityCharacteristics() {
    const humidity = this.getCurrentHumidity();
    this.humidifierService
      .getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
      .updateValue(humidity);
    this.humiditySensor
      .getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
      .updateValue(humidity);
  }

  private updateCurrentStateCharacteristic() {
    this.humidifierService
      .getCharacteristic(this.platform.Characteristic.CurrentHumidifierDehumidifierState)
      .updateValue(this.getCurrentDehumidifierState());
  }

  private toBoolean(value: RawReportedValue): boolean {
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

  private toNumber(value: RawReportedValue): number | undefined {
    if (value === undefined) {
      return undefined;
    }
    const num = Number(value);
    return Number.isFinite(num) ? num : undefined;
  }

  private normalizeHumidity(value: RawReportedValue): number {
    const num = this.toNumber(value);
    if (num === undefined) {
      return this.HUMIDITY_DEFAULT;
    }
    const rounded = Math.round(num);
    return Math.min(100, Math.max(0, rounded));
  }

  private clampTargetHumidity(value: RawReportedValue): number {
    const num = this.toNumber(value);
    if (num === undefined) {
      return this.HUMIDITY_DEFAULT;
    }
    const rounded = Math.round(num);
    return Math.min(this.HUMIDITY_MAX, Math.max(this.HUMIDITY_MIN, rounded));
  }

  private determineMaxFanLevel(state: DreoDehumidifierState): number {
    const stateMax = this.toNumber(state.windlevel?.max);
    if (stateMax !== undefined && stateMax > 0) {
      return Math.max(1, Math.round(stateMax));
    }

    const controls = this.accessory.context.device.controlsConf?.control;
    if (Array.isArray(controls)) {
      for (const control of controls) {
        const type = (control?.type ?? '').toString().toLowerCase();
        if (type.includes('speed') || type.includes('wind')) {
          const items: any[] = Array.isArray(control?.items) ? control.items : [];
          const candidate = items[items.length - 1];
          const extracted = Number(candidate?.value ?? candidate?.text ?? candidate);
          if (!Number.isNaN(extracted) && extracted > 0) {
            return Math.max(1, Math.round(extracted));
          }
        }
      }
    }

    return 3;
  }

  private toValidFanLevel(value: number | undefined): number {
    if (!value || value <= 0) {
      return 1;
    }
    const max = Math.max(1, this.currState.maxFanLevel);
    return Math.min(max, Math.max(1, Math.round(value)));
  }

  private toTemperature(value: RawReportedValue): number | undefined {
    const num = this.toNumber(value);
    if (num === undefined) {
      return undefined;
    }
    if (num > 45) {
      return Math.round(((num - 32) * 5) / 9 * 10) / 10;
    }
    return Math.round(num * 10) / 10;
  }

  private getRotationSpeedValue(): number {
    const percent = (this.currState.fanLevel / this.currState.maxFanLevel) * 100;
    return Math.max(0, Math.min(100, Math.round(percent)));
  }

  private getCurrentDehumidifierState() {
    if (!this.currState.on) {
      return this.platform.Characteristic.CurrentHumidifierDehumidifierState.INACTIVE;
    }

    if (this.currState.humidity <= this.currState.targetHumidity) {
      return this.platform.Characteristic.CurrentHumidifierDehumidifierState.IDLE;
    }

    return this.platform.Characteristic.CurrentHumidifierDehumidifierState.DEHUMIDIFYING;
  }

  private getCurrentHumidity() {
    return this.currState.humidity;
  }

  private getTargetHumidity() {
    return this.currState.targetHumidity;
  }

  private getCurrentTemperature() {
    return this.currState.temperature ?? 0;
  }

  private getRotationSpeed() {
    return this.getRotationSpeedValue();
  }

  private getContinuousMode() {
    return this.currState.mode === this.MODE_CONTINUOUS;
  }

  private getPanelSound() {
    return this.currState.panelSound;
  }

  private getDisplayLight() {
    return this.currState.displayLight;
  }

  private getChildLock() {
    return this.currState.childLock;
  }

  setActive(value) {
    const isActive = this.toBoolean(value as RawReportedValue);
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

  private setTargetHumidity(value: unknown) {
    const humidity = this.clampTargetHumidity(value as RawReportedValue);
    this.currState.targetHumidity = humidity;
    this.humidifierService
      .getCharacteristic(this.platform.Characteristic.RelativeHumidityDehumidifierThreshold)
      .updateValue(humidity);
    this.platform.webHelper.control(this.sn, { rhautolevel: humidity });
    this.updateCurrentStateCharacteristic();
  }

  private setRotationSpeed(value: unknown) {
    const numeric = this.toNumber(value as RawReportedValue) ?? 0;
    if (numeric <= 0) {
      this.setActive(false);
      return;
    }
    const converted = Math.max(
      1,
      Math.min(
        this.currState.maxFanLevel,
        Math.round((numeric * this.currState.maxFanLevel) / 100),
      ),
    );
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
    this.platform.webHelper.control(this.sn, {
      poweron: true,
      windlevel: converted,
    });
  }

  private setChildLock(value: unknown) {
    const enabled = this.toBoolean(value as RawReportedValue);
    this.currState.childLock = enabled;
    this.humidifierService
      .getCharacteristic(this.platform.Characteristic.LockPhysicalControls)
      .updateValue(this.getChildLock());
    this.platform.webHelper.control(this.sn, { childlockon: Number(enabled) });
  }

  private setContinuousMode(value: unknown) {
    const continuous = this.toBoolean(value as RawReportedValue);
    const nextMode = continuous ? this.MODE_CONTINUOUS : this.MODE_AUTO;
    this.currState.mode = nextMode;
    const command: Record<string, number | boolean> = { mode: nextMode };
    if (!this.currState.on) {
      this.currState.on = true;
      command.poweron = true;
      this.humidifierService
        .getCharacteristic(this.platform.Characteristic.Active)
        .updateValue(this.currState.on);
    }
    this.modeSwitch?.getCharacteristic(this.platform.Characteristic.On)
      .updateValue(continuous);
    this.platform.webHelper.control(this.sn, command);
    this.updateCurrentStateCharacteristic();
  }

  private setPanelSound(value: unknown) {
    const enabled = this.toBoolean(value as RawReportedValue);
    this.currState.panelSound = enabled;
    this.panelSoundSwitch?.getCharacteristic(this.platform.Characteristic.On)
      .updateValue(enabled);
    this.platform.webHelper.control(this.sn, { muteon: !enabled });
  }

  private setDisplayLight(value: unknown) {
    const enabled = this.toBoolean(value as RawReportedValue);
    this.currState.displayLight = enabled;
    this.displayLightSwitch?.getCharacteristic(this.platform.Characteristic.On)
      .updateValue(enabled);
    this.platform.webHelper.control(this.sn, { lighton: enabled });
  }
}
