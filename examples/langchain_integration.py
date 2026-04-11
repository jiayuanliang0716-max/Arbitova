"""
Arbitova + LangChain Integration Example

Shows how to use Arbitova escrow and arbitration as LangChain tools
in a multi-agent workflow.

Install:
    pip install arbitova langchain langchain-anthropic
"""

import os
from langchain.tools import tool
from langchain_anthropic import ChatAnthropic
from langchain.agents import AgentExecutor, create_tool_calling_agent
from langchain_core.prompts import ChatPromptTemplate
from arbitova import Arbitova

client = Arbitova(api_key=os.environ["ARBITOVA_API_KEY"])


# ── Arbitova Tools ────────────────────────────────────────────────────────────

@tool
def arbitova_create_escrow(service_id: str, requirements: dict) -> dict:
    """
    Lock funds in escrow before a worker agent starts a task.
    Returns a transaction object with an ID to track the job.
    """
    return client.escrow(service_id=service_id, requirements=requirements)


@tool
def arbitova_verify_delivery(transaction_id: str) -> dict:
    """
    Trigger N=3 AI arbitration to verify a delivered task.
    Returns verdict: {winner, confidence, ai_votes}.
    """
    return client.arbitrate(transaction_id)


@tool
def arbitova_dispute(transaction_id: str, reason: str) -> dict:
    """
    Open a dispute and trigger AI arbitration.
    Use when delivered work does not meet requirements.
    """
    client.dispute(transaction_id, reason=reason)
    return client.arbitrate(transaction_id)


@tool
def arbitova_trust_score(agent_id: str) -> dict:
    """
    Get reputation score for an agent before transacting.
    Returns score, level, and per-category breakdown.
    """
    return client.get_reputation(agent_id)


@tool
def arbitova_release(transaction_id: str) -> dict:
    """Manually confirm and release escrow funds to the seller."""
    return client.confirm(transaction_id)


# ── Agent Setup ───────────────────────────────────────────────────────────────

tools = [
    arbitova_create_escrow,
    arbitova_verify_delivery,
    arbitova_dispute,
    arbitova_trust_score,
    arbitova_release,
]

llm = ChatAnthropic(model="claude-sonnet-4-6", api_key=os.environ["ANTHROPIC_API_KEY"])

prompt = ChatPromptTemplate.from_messages([
    ("system", """You are an orchestrator agent that manages payments for worker agents.
Before hiring a worker, check their trust score.
After work is delivered, use AI verification before releasing funds.
If verification fails, open a dispute."""),
    ("human", "{input}"),
    ("placeholder", "{agent_scratchpad}"),
])

agent = create_tool_calling_agent(llm, tools, prompt)
executor = AgentExecutor(agent=agent, tools=tools, verbose=True)


# ── Example Run ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    result = executor.invoke({
        "input": (
            "I need to hire agent 'abc123' for service 'svc_xyz'. "
            "First check their trust score, then create an escrow for the job."
        )
    })
    print(result["output"])
