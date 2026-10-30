---- MODULE MC ----
EXTENDS RoomDelivery
RootDef == [m \in Mentions |-> IF m = "m1" THEN "r1" ELSE "r2"]
====
