/**
 * The DNS stack: the hosted zone for the domain and the records that must exist
 * before anything else can — the root mailbox's MX and DKIM.
 *
 * It is its own stack because the site's certificate validates through the
 * domain's *public* nameservers: the zone has to exist, and the registrar has to
 * point at it, before `ZudocsSite` can ever finish. So the order is: deploy this,
 * point the registrar at the `NameServers` output, wait for `dig NS` to agree,
 * then deploy the site. The zone is retained on delete — its nameservers are what
 * the registrar knows, and a replacement would get different ones.
 *
 * @example
 * ```ts
 * const dns = new DnsStack(app, "ZudocsDns", { config, env });
 * new SiteStack(app, "ZudocsSite", { config, env, zone: dns.zone });
 * ```
 */
import * as cdk from "aws-cdk-lib";
import { aws_route53 as route53 } from "aws-cdk-lib";
import type { Construct } from "constructs";
import type { ZudocsConfig } from "./config.js";

export interface DnsStackProps extends cdk.StackProps {
  readonly config: ZudocsConfig;
}

export class DnsStack extends cdk.Stack {
  readonly zone: route53.PublicHostedZone;

  constructor(scope: Construct, id: string, props: DnsStackProps) {
    super(scope, id, props);
    const { config } = props;
    this.zone = new route53.PublicHostedZone(this, "Zone", { zoneName: config.domain, comment: "Zudocs (a fictional company built to demonstrate AirPrompter)" });
    this.zone.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
    // The root mailbox: SES inbound in the organisation's management account forwards every
    // address at the domain to the owner. The MX and DKIM records travel with the zone.
    new route53.MxRecord(this, "Mx", { zone: this.zone, values: [{ priority: 10, hostName: `inbound-smtp.${config.mail.inboundRegion}.amazonaws.com` }], ttl: cdk.Duration.minutes(5) });
    config.mail.dkimTokens.forEach((token, i) => {
      new route53.CnameRecord(this, `Dkim${i + 1}`, { zone: this.zone, recordName: `${token}._domainkey`, domainName: `${token}.dkim.amazonses.com`, ttl: cdk.Duration.minutes(5) });
    });
    new cdk.CfnOutput(this, "NameServers", { value: cdk.Fn.join(" ", this.zone.hostedZoneNameServers ?? []), description: "Point the registrar at these once, then deploy ZudocsSite" });
    new cdk.CfnOutput(this, "ZoneId", { value: this.zone.hostedZoneId });
  }
}
