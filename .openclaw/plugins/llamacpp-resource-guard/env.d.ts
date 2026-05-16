declare module "openclaw/plugin-sdk/plugin-entry" {
  export function definePluginEntry(config: {
    id: string;
    name: string;
    description: string;
    configSchema: Record<string, any>;
    register: (api: any) => void;
  }): any;
}
