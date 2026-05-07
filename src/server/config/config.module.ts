import { Global, Module } from "@nestjs/common";
import { readEnv } from "./env.js";

export const APP_ENV = "APP_ENV";

@Global()
@Module({
  providers: [
    {
      provide: APP_ENV,
      useFactory: () => readEnv(),
    },
  ],
  exports: [APP_ENV],
})
export class ConfigModule {}
