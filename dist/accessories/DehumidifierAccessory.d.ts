import { PlatformAccessory } from 'homebridge';
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
export declare class DehumidifierAccessory extends BaseAccessory {
    private readonly humidifierService;
    private readonly humiditySensor;
    private targetHumiditySensor?;
    private temperatureSensor?;
    private panelSoundSwitch?;
    private displayLightSwitch?;
    private readonly supportsWindLevel;
    private targetHumidityDebounceTimer?;
    private fanSpeedDebounceTimer?;
    private pendingTargetHumidity?;
    private pendingFanLevel?;
    private readonly COMMAND_DEBOUNCE_MS;
    private readonly HUMIDITY_MIN;
    private readonly HUMIDITY_MAX;
    private readonly HUMIDITY_DEFAULT;
    private readonly MODE_AUTO;
    private readonly MODE_CONTINUOUS;
    private currState;
    constructor(platform: DreoPlatform, accessory: PlatformAccessory, state: DreoDehumidifierState);
    private initializeStateFromSnapshot;
    private configureHumidifierService;
    private configureAuxiliaryServices;
    private refreshInitialCharacteristics;
    private registerWebSocketListener;
    private handleIncomingUpdate;
    private updateHumidityCharacteristics;
    private updateCurrentStateCharacteristic;
    private toBoolean;
    private toNumber;
    private normalizeHumidity;
    private clampTargetHumidity;
    private determineMaxFanLevel;
    private toValidFanLevel;
    private toTemperature;
    private getRotationSpeedValue;
    private getCurrentDehumidifierState;
    private getCurrentHumidity;
    private getTargetHumidity;
    private getCurrentTemperature;
    private getRotationSpeed;
    private getTargetHumidifierDehumidifierState;
    private getPanelSound;
    private getDisplayLight;
    setActive(value: any): void;
    getActive(): boolean;
    private setTargetHumidifierDehumidifierState;
    private setTargetHumidity;
    private setRotationSpeed;
    private scheduleTargetHumidityCommand;
    private scheduleFanSpeedCommand;
    private setPanelSound;
    private setDisplayLight;
}
export {};
//# sourceMappingURL=DehumidifierAccessory.d.ts.map