import { makeSecretProviderDefinitionRegistry } from "@t3tools/secret-provider-core/shared/definition.ts";
import * as OnePassword from "@t3tools/secret-provider-onepassword/shared/definition.ts";

export const builtInSecretProviderDefinitions = makeSecretProviderDefinitionRegistry([
  OnePassword.definition,
]);
