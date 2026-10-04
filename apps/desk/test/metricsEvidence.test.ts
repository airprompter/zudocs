import assert from "node:assert/strict";
import { test } from "node:test";
import { daemonDelivery } from "../src/metricsEvidence";
import type { HostStatus, TimelineEvent } from "../src/api";

test("delivery evidence is scoped to the current host and successful CLI status, with safe fields only", () => {
  const host={hostId:'eu-west-1/ec2',ec2:{instanceId:'i-current'}} as HostStatus;
  const event={at:'2026-10-04T05:00:00Z',kind:'host_cli',host:'us-east-1/lambda',command:'status',status:'Success',forHost:host.hostId,instanceId:'i-current',document:{daemon:{live:true,uploadIntervalSeconds:300,upload:{lastUploadAt:'2026-10-04T04:54:00Z',sentSegments:19,quarantinedSegments:0,droppedSegments:-1,depthSegments:0,extra:'ignored'}}}} as TimelineEvent;
  assert.equal(daemonDelivery([event],host)?.sent,19);
  assert.equal(daemonDelivery([event],host)?.dropped,null);
  assert.equal(daemonDelivery([{...event,instanceId:'i-old'}],host),null);
  assert.equal(daemonDelivery([{...event,status:'Failed'}],host),null);
  assert.equal(daemonDelivery([{...event,forHost:'another-host'}],host),null);
  assert.equal(daemonDelivery([{...event,at:'bad-date'}],host),null);
  assert.ok(!JSON.stringify(daemonDelivery([event],host)).includes('extra'));
});
