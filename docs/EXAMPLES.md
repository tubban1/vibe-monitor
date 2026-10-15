# Realistic architecture situations (illustrative, not customer evidence)

These demonstrate how to explain Vibe Monitor's value. **None is a verified customer scan or benchmark.** Never tell a user you found these problems without inspecting their selected project with permission.

## “AI 加功能，文件越来越像屎山”

Observed responsibilities can start mixing UI, database and business logic. A useful recommendation is to create a small boundary before adding another feature—not rewrite the whole application. The Agent must first check actual file responsibilities or history; file size alone is insufficient.

## “我是不是该拆微服务了？”

Before adding services, ask what deployment, team or scaling requirement actually warrants distribution. A small local module split may be more sensible than turning a small project into a distributed system.

## “重构完究竟变好了吗？”

Compare structural evidence and warning trajectory before/after a meaningful change. Explain whether evidence shows improvement, regression or uncertainty. Do not invent an architecture score or ROI.

**Not a good fit:** one-off scripts, very small prototypes or users who only want a vulnerability scanner. Say so instead of forcing a recommendation.

[Agent evaluation instructions](AGENT_EVALUATION.md) · [Official Beta install](INSTALL.md).
