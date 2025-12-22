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
  private targetHumiditySensor?: Service;
  private temperatureSensor?: Service;
  private panelSoundSwitch?: Service;
  private displayLightSwitch?: Service;
  private readonly supportsWindLevel: boolean;
  private targetHumidityDebounceTimer?: NodeJS.Timeout;
  private fanSpeedDebounceTimer?: NodeJS.Timeout;
  private pendingTargetHumidity?: number;
  private pendingFanLevel?: number;
  private readonly COMMAND_DEBOUNCE_MS = 600;

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

  private initializeStateFromSnapshot(state: DreoDehumidifierState) {
    this.currState.on = this.toBoolean(state.poweron?.state ?? false);
    this.currState.mode = (this.toNumber(state.mode?.state) as ContinuousMode) ?? this.MODE_AUTO;
    this.currState.humidity = this.normalizeHumidity(state.rh?.state ?? state.humidity?.state);
    this.currState.targetHumidity = this.clampTargetHumidity(state.rhautolevel?.state);
    this.currState.maxFanLevel = this.determineMaxFanLevel(state);
    this.currState.fanLevel = this.toValidFanLevel(this.toNumber(state.windlevel?.state));
    this.currState.displayLight = this.toBoolean(state.lighton?.state ?? false);
    this.currState.panelSound = !this.toBoolean(state.muteon?.state ?? false);
    this.currState.autoOn = this.toBoolean(state.autoon?.state ?? this.currState.mode === this.MODE_AUTO);
    this.currState.temperature = this.toTemperature(state.temperature?.state);
  }

  private configureHumidifierService(deviceName: string) {
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
  }

  private configureAuxiliaryServices(state: DreoDehumidifierState, deviceName: string) {
    const existingTemperatureService = this.accessory.getService(this.platform.Service.TemperatureSensor);
    const hideTemperatureSensor = this.platform.config.hideTemperatureSensor ?? false;

    if (!hideTemperatureSensor && state.temperature !== undefined) {
      this.temperatureSensor = existingTemperatureService ||
        this.accessory.addService(this.platform.Service.TemperatureSensor, 'Temperature Sensor');

      this.temperatureSensor
        .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
        .onGet(this.getCurrentTemperature.bind(this));
    } else if (hideTemperatureSensor && existingTemperatureService) {
      this.accessory.removeService(existingTemperatureService);
    }

    const existingTargetHumidityService = this.accessory.getServiceById(this.platform.Service.HumiditySensor, 'TargetHumidity');
    const hideTargetHumiditySensor = this.platform.config.hideTargetHumiditySensor ?? true;

    if (!hideTargetHumiditySensor) {
      this.targetHumiditySensor = existingTargetHumidityService ||
        this.accessory.addService(this.platform.Service.HumiditySensor, 'Target Humidity', 'TargetHumidity');

      this.targetHumiditySensor
        .setCharacteristic(this.platform.Characteristic.Name, 'Target Humidity')
        .updateCharacteristic(this.platform.Characteristic.Name, 'Target Humidity');

      this.targetHumiditySensor
        .getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
        .onGet(this.getTargetHumidity.bind(this));
    } else if (hideTargetHumiditySensor && existingTargetHumidityService) {
      this.accessory.removeService(existingTargetHumidityService);
    }

    const existingModeSwitch = this.accessory.getServiceById(this.platform.Service.Switch, 'ContinuousMode');
    if (existingModeSwitch) {
      this.accessory.removeService(existingModeSwitch);
    }

    const existingPanelSoundSwitch = this.accessory.getServiceById(this.platform.Service.Switch, 'PanelSound');
    const hidePanelSoundSwitch = this.platform.config.hidePanelSoundSwitch ?? true;

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
    } else if (hidePanelSoundSwitch && existingPanelSoundSwitch) {
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
    this.targetHumiditySensor
      ?.getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
      .updateValue(this.currState.targetHumidity);
    if (this.supportsWindLevel) {
      this.humidifierService
        .getCharacteristic(this.platform.Characteristic.RotationSpeed)
        .updateValue(this.getRotationSpeed());
    }
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
        this.targetHumiditySensor
          ?.getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
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
        this.humidifierService
          .getCharacteristic(this.platform.Characteristic.TargetHumidifierDehumidifierState)
          .updateValue(this.getTargetHumidifierDehumidifierState());
        this.updateCurrentStateCharacteristic();
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
          const items = Array.isArray(control?.items) ? (control.items as unknown[]) : [];
          const candidate = items[items.length - 1] as unknown;
          const candidateObj = candidate as { value?: unknown; text?: unknown };
          const extracted = Number(candidateObj?.value ?? candidateObj?.text ?? candidate);
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

  private getTargetHumidifierDehumidifierState() {
    // Map device mode to HomeKit dropdown.
    // We use HUMIDIFIER_OR_DEHUMIDIFIER for Auto, DEHUMIDIFIER for Continuous.
    return this.currState.mode === this.MODE_CONTINUOUS
      ? this.platform.Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER
      : this.platform.Characteristic.TargetHumidifierDehumidifierState.HUMIDIFIER_OR_DEHUMIDIFIER;
  }

  private getPanelSound() {
    return this.currState.panelSound;
  }

  private getDisplayLight() {
    return this.currState.displayLight;
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

  private setTargetHumidifierDehumidifierState(value: unknown) {
    const numeric = this.toNumber(value as RawReportedValue);
    if (numeric === undefined) {
      return;
    }

    const isContinuous =
      numeric === this.platform.Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER;
    const nextMode = isContinuous ? this.MODE_CONTINUOUS : this.MODE_AUTO;
    if (this.currState.mode === nextMode) {
      return;
    }

    this.currState.mode = nextMode;
    const command: Record<string, number | boolean> = { mode: nextMode };
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

  private setTargetHumidity(value: unknown) {
    const humidity = this.clampTargetHumidity(value as RawReportedValue);
    this.currState.targetHumidity = humidity;
    this.humidifierService
      .getCharacteristic(this.platform.Characteristic.RelativeHumidityDehumidifierThreshold)
      .updateValue(humidity);
    this.targetHumiditySensor
      ?.getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
      .updateValue(humidity);
    this.scheduleTargetHumidityCommand(humidity);
    this.updateCurrentStateCharacteristic();
  }

  private setRotationSpeed(value: unknown) {
    const numeric = this.toNumber(value as RawReportedValue) ?? 0;
    if (numeric <= 0) {
      if (this.fanSpeedDebounceTimer) {
        clearTimeout(this.fanSpeedDebounceTimer);
        this.fanSpeedDebounceTimer = undefined;
      }
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
    this.scheduleFanSpeedCommand(converted);
  }

  private scheduleTargetHumidityCommand(value: number) {
    this.pendingTargetHumidity = value;
    if (this.targetHumidityDebounceTimer) {
      clearTimeout(this.targetHumidityDebounceTimer);
    }
    this.targetHumidityDebounceTimer = setTimeout(() => {
      if (this.pendingTargetHumidity !== undefined) {
        this.platform.webHelper.control(this.sn, { rhautolevel: this.pendingTargetHumidity });
      }
      this.targetHumidityDebounceTimer = undefined;
    }, this.COMMAND_DEBOUNCE_MS);
  }

  private scheduleFanSpeedCommand(level: number) {
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
