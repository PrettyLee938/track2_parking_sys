# Challenge overview

Source: `Track 2 specs.pdf`, pages 1, 3-6, and 39-40.

## Mission

Build a web-based parking management system for Grand Park Auto. The
simulator reports what is happening through webhooks. The management system
decides what to do and sends commands through the simulator REST API.

The system must keep cars moving, organize parking capacity, handle payments,
monitor equipment, and keep an operational history that an operator can inspect.

## Connection flow from the PDF

1. Register the team and download the simulator.
2. Edit `Settings/settings.json` with the webhook URL, listen address, team
   name, and simulator login credentials.
3. Start the web server, webhook listener, and database.
4. Start the simulator and confirm its REST URL and webhook messages.
5. Log in to the simulator API and use the returned bearer token for protected
   requests.
6. Call the listing endpoints to inspect the current level.
7. Trigger a test webhook and verify that the listener stores and processes it.

## Level 1 requirements

The first level asks for a working web system that can:

- list parking spots and open or close gates through the simulator API;
- receive a car arrival at an entry spot and guide the car to a suitable space;
- handle the exit flow, calculate the parking charge, request payment, and
  send the car out after payment validation;
- show the status of gates, spots, occupancy, and free capacity on a dashboard;
- provide basic authentication with Admin and Operator roles;
- log arrivals, parking time, departures, and charges in a database;
- keep the dashboard data current as simulator events arrive.

## Operational loop

```text
entry webhook
  -> inspect compatible free spots
  -> open the correct gate
  -> send the car to a legal destination
  -> wait for spot and gate webhooks
  -> detect the exit spot
  -> calculate and request payment once
  -> validate payment
  -> send the car through the exit
  -> store the complete history
```

The PDF states that cars can leave when they wait too long. The system should
therefore handle an entry timeout explicitly instead of leaving a car in an
unknown state.

## What is a source requirement versus a team choice?

The endpoint names, webhook fields, component restrictions, charge rules, and
penalty names in these references come from the PDF. Database schema, module
names, framework choices, and the optional Jev advisor are repository decisions
and must remain replaceable around the simulator boundary.
