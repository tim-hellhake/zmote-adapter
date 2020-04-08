/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */

import { Adapter, Device, Database } from 'gateway-addon';

import fetch from 'node-fetch';

import crypto from 'crypto';

interface Zmote {
  type: string,
  make: string,
  model: string,
  name: string,
  chipID: string,
  fwVersion: string,
  state: string,
  localIP: string
}

interface Config {
  version: string,
  commands: Command[]
}

interface Command {
  id: string,
  name: string,
  zmoteUuid: string,
  zmoteIp: string,
  data: string
}

class CommandDevice extends Device {
  constructor(adapter: any, public command: Command) {
    super(adapter, command.id);
    this['@context'] = 'https://iot.mozilla.org/schemas/';
    this.name = command.name;

    this.addAction('send', {
      title: 'Send',
    });
  }

  async performAction(action: any) {
    action.start();

    if (action.name === 'send') {
      const url = `http://${this.command.zmoteIp}/v2/${this.command.zmoteUuid}`;
      const response = await fetch(url, {
        method: 'POST',
        body: this.command.data
      });
      console.log(`Device responded with ${response.status}`);
    } else {
      console.log(`Unknown action ${action.name}`);
    }

    action.finish();
  }
}

export class ZmoteAdapter extends Adapter {
  private db: Database;
  private pairing = false
  private foundDevices: { [key: string]: CommandDevice } = {};

  constructor(addonManager: any, manifest: any) {
    super(addonManager, ZmoteAdapter.name, manifest.name);
    addonManager.addAdapter(this);

    this.db = new Database(manifest.id);
    this.init();
  }

  private async init() {
    await this.db.open();
    const config: Config = await this.db.loadConfig();

    if (config.commands) {
      for (const command of config.commands) {
        console.log(`Creating device for command ${command.name}`);
        const device = new CommandDevice(this, command);
        this.handleDeviceAdded(device);
      }
    }
  }

  async findZmotes(): Promise<Zmote[]> {
    const url = 'https://api.zmote.io/discover';
    const result = await fetch(url);
    return await result.json();
  }

  async startPairing() {
    console.log('Starting discovery');
    this.pairing = true;
    const zmotes = await this.findZmotes();

    for (const zmote of zmotes) {
      console.log(`Found zmote ${zmote.name} at ${zmote.localIP}`);
      this.startListenLoop(zmote);
    }
  }

  handleDeviceSaved(deviceId: string) {
    const device = this.foundDevices[deviceId];

    if (device) {
      delete this.foundDevices[deviceId];
      this.saveDevice(device);
    } else {
      console.log(`Saved device ${deviceId} not found`);
    }
  }

  async cancelPairing() {
    console.log('Stopping discovery');
    this.pairing = false;
  }

  private async startListenLoop(zmote: Zmote) {
    while (this.pairing) {
      await this.listenForIrCommands(zmote);
    }
  }

  private async listenForIrCommands(zmote: Zmote) {
    console.log(`Start learning on ${zmote.name} at ${zmote.localIP}`)
    const url = `http://${zmote.localIP}/v2/${zmote.chipID}`;
    const result = await fetch(url, {
      method: 'POST',
      body: 'get_IRL'
    });
    const text = await result.text();
    const parts = text.split('\n')
      .map(s => s.replace('\r', ''))
      .map(s => s.trim())
      .filter(s => s.length > 0);

    if (parts.length > 1) {
      const command: Command = {
        id: `${crypto.randomBytes(16).toString('hex')}`,
        name: 'zmote ir command',
        zmoteUuid: zmote.chipID,
        zmoteIp: zmote.localIP,
        data: parts[1]
      }

      console.log(`Learned command ${command.data}`);
      const device = new CommandDevice(this, command);
      this.handleDeviceAdded(device);
      this.foundDevices[device.id] = device;
      console.log(`Found device ${device.id}`);
    } else {
      if (parts.length == 1) {
        console.log(`No IR signal received by ${zmote.name} at ${zmote.localIP}`);
      }
    }
  }

  async saveDevice(device: CommandDevice) {
    console.log(`Saving device ${device.id}`);
    const config: Config = await this.db.loadConfig();

    config.version = config.version || '0.1.0';
    config.commands = config.commands || [];
    config.commands.push(device.command);
    this.db.saveConfig(config);
  }
}
