import { IdentityRestClient } from "@twin.org/identity-rest-client";
import type { IJsonLdNodeObject } from "@twin.org/data-json-ld";
import type { IDidVerifiableCredential } from "@twin.org/standards-w3c-did";
import { HttpMethod } from "@twin.org/web";

interface VerifiableCredentialCreateOptions {
  revocationIndex?: number;
  expirationDate?: Date;
  jwtHeaderFields?: { [id: string]: string };
  jwtPayloadFields?: { [id: string]: string };
}

interface VerifiableCredentialCreateResponse {
  verifiableCredential: IDidVerifiableCredential;
  jwt: string;
}

// Workaround for @twin.org/identity-rest-client: verifiableCredentialCreate
// omits the :verificationMethodId path segment, causing POST .../verifiable-credential
// instead of POST .../verifiable-credential/<vmId>. Remove this subclass when
// the upstream package is fixed (see xroad-twin-adaptor-pattern Section 8).
export class PatchedIdentityRestClient extends IdentityRestClient {
  public override async verifiableCredentialCreate(
    verificationMethodId: string,
    id: string | undefined,
    subject: IJsonLdNodeObject,
    options?: VerifiableCredentialCreateOptions,
  ): Promise<VerifiableCredentialCreateResponse> {
    const hash = verificationMethodId.indexOf("#");
    const identity = hash >= 0 ? verificationMethodId.slice(0, hash) : verificationMethodId;
    const fragment = hash >= 0 ? verificationMethodId.slice(hash + 1) : "";

    const response = await this.fetch<
      {
        pathParams: { identity: string; verificationMethodId: string };
        body: {
          credentialId: string | undefined;
          subject: IJsonLdNodeObject;
          revocationIndex: number | undefined;
          expirationDate: string | undefined;
          jwtHeaderFields: { [id: string]: string } | undefined;
          jwtPayloadFields: { [id: string]: string } | undefined;
        };
      },
      { body: VerifiableCredentialCreateResponse }
    >("/:identity/verifiable-credential/:verificationMethodId", HttpMethod.POST, {
      pathParams: { identity, verificationMethodId: fragment },
      body: {
        credentialId: id,
        subject,
        revocationIndex: options?.revocationIndex,
        expirationDate: options?.expirationDate?.toISOString(),
        jwtHeaderFields: options?.jwtHeaderFields,
        jwtPayloadFields: options?.jwtPayloadFields,
      },
    });

    return response.body;
  }
}
