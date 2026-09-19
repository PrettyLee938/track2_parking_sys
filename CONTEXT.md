# Grand Park Auto

Grand Park Auto is the simulated parking facility that the team's management system operates. These terms follow the supplied Track 2 specification.

## Language

**Car**:
A vehicle identified by its plate number, with a type and a planned parking duration. A returning car can have multiple separate parking sessions.

**Parking session**:
One visit by a car to the facility, encompassing arrival, parking, payment, and departure.
_Avoid_: Treating a plate number as a unique visit.

**Parking spot**:
A space for one parked car, with a suitability type of Any, Electric, or Accessible.
_Avoid_: Using this term for an entry or exit detection point.

**Entry spot**:
A detection point where arriving cars wait to enter the facility.

**Exit spot**:
A detection point where departing cars request and complete payment before leaving.

**Barrier gate**:
A physical barrier that controls passage and can be open, closed, opening, or closing.
_Avoid_: Entry spot, exit spot.

**Zone**:
A named area containing parking components and its own carbon monoxide conditions.

**Invoice**:
The parking and applicable electricity charges requested for one parking session at the exit spot.
_Avoid_: Payment, receipt.

**Payment**:
A reported transfer against a session's invoice that must be validated before departure is authorized.
_Avoid_: Treating an invoice or an unvalidated payment notification as proof of payment.

**Predictive maintenance**:
Maintenance performed before a component breaks, using its usage or operating history to anticipate failure.
_Avoid_: Repair after failure.

**Penalty**:
A deduction of simulator credits for violating a challenge requirement.

**Level**:
A simulator scenario with a particular layout, available components, and enforced requirements.

**Operator**:
A parking control-center user who monitors the facility and issues actions subject to the parking rules.
_Avoid_: Admin.

**Admin**:
A parking control-center user with administrative authority, including explicit business exceptions, who remains subject to equipment and occupancy restrictions.
_Avoid_: Operator.

**Admin override**:
An explicit business exception authorized by an Admin, such as permission for an unpaid departure, that preserves equipment and occupancy restrictions. It does not alter the facts of a parking session, such as whether payment was actually received.
_Avoid_: Successful payment, normal operation.

**Unpaid-release authorization**:
An Admin's permission, with a recorded reason, for one car's current parking session to end without validated payment. It is consumed on confirmed departure and does not apply to other cars or later visits.
_Avoid_: Payment, permanent exemption.

**Admin-authorized unpaid departure**:
A completed departure permitted by an unpaid-release authorization, with the session's unpaid status retained.
_Avoid_: Paid departure.

**Override record**:
The auditable evidence of an Admin-authorized business exception, including who authorized it, why, which session it affected, and what outcome followed.
_Avoid_: Hiding an exception as a normal payment or departure.

**Operator account**:
An application identity used to monitor and operate the parking control center within the normal rules. An Operator cannot authorize a business exception.
_Avoid_: Simulator account.

**Admin account**:
An application identity with user-management, recovery, and explicit business-exception authority, while remaining subject to equipment and occupancy restrictions.
_Avoid_: Sharing the simulator account with dashboard users.

**Simulator run**:
A continuous instance of a level whose events and operational state share one run identity. A new level or reset starts a different run, even when a car plate or component name is reused.
_Avoid_: Treating a backend restart as an automatic new run.

**Unknown command outcome**:
An external action whose final result cannot be established from a reliable simulator response or event. It remains uncertain until evidence or a documented reconciliation resolves it.
_Avoid_: Treating a timeout as proof of failure or success.

**Run closure**:
The transition that makes a simulator run read-only while preserving unresolved sessions and commands before a new run starts without carrying operational or payment state forward.
_Avoid_: Deleting the previous run or silently merging it into the new run.

**Audit correction**:
An append-only record that explains a revised interpretation of an earlier event or action while preserving the original record unchanged.
_Avoid_: Editing history in place.
