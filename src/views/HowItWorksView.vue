<template>
  <div class="how-it-works">
    <div class="content">
      <section>
        <h2>Trustless coinflip</h2>

        <p>
          Coinflip is a game of chance with two players. The first player (A) chooses "Heads" or "Tails" and the second player (B) tries to guess the coin's side.
          If the second player guesses the coin's side correctly, he wins and the first player loses. Otherwise, the first player wins and the second player loses.
          <br>
          <br>
          The game is built on Bitcoin's Taproot and multisignature capabilities. The emulation of coinflip is made with secret generation of predetermined sizes. 
          Both players generate a secret of 15 or 16 bytes. 15 is "Heads" and 16 is "Tails". This method is inspired by <a href="https://arxiv.org/pdf/1612.05390v3">https://arxiv.org/pdf/1612.05390v3</a>.
        </p>

        <br>
        <p>
          The game involves three transactions:
          <br>
          <br>
        </p>
        <ul>
          <li>The <b>setup transaction</b> is forcing the first player to reveal his secret.</li>
          <li>The <b>final transaction</b> is forcing the second player to reveal his secret.</li>
          <li>The <b>cashout transaction</b> is made by the winner of the game to get his funds.</li>
        </ul>
        <br>
        <p>
          The <b>final transaction</b> is signed BEFORE the <b>setup transaction</b>.
          Thus, once the <b>setup transaction</b> is submitted, the funds can only be spent through the <b>final transaction</b>.
        </p>


        <div class="game-flow">
          <div class="flow-diagram">
            <div class="tx funding-tx">
              <div class="tx-header">
                <h4>Setup Transaction</h4>
              </div>
              <div class="tx-body">
                <div class="inputs">
                  <div class="input">
                    <h5>Inputs</h5>
                    <p>VTXO 1</p>
                    <small>Signed by A</small>
                  </div>
                  <div class="input">
                    <p>VTXO 2</p>
                    <small>Signed by B</small>
                  </div>
                </div>
                <div class="arrow">→</div>
                <div class="outputs">
                  <div class="output">
                    <h5>Output</h5>
                    <p>(A + B + secret A) OR (B after timeout)</p>
                    <small>force reveal secret A</small>
                  </div>
                </div>
              </div>
            </div>

            <div class="tx-separator">↓</div>

            <div class="tx payout-tx">
              <div class="tx-header">
                <h4>Final Transaction</h4>
              </div>
              <div class="tx-body">
                <div class="inputs">
                  <div class="input">
                    <h5>Input</h5>
                    <p>Setup transaction output</p>
                    <small>Presigned by A & B</small>
                  </div>
                </div>
                <div class="arrow">→</div>
                <div class="outputs split">
                  <div class="output">
                    <h5>Output</h5>
                    <h4>If len(secret A) == len(secret B)</h4>
                    <p>B + secret B</p>
                    <h4>Else if len(secret A) != len(secret B)</h4>
                    <p>A + secret B</p>
                    <h4>Else</h4>
                    <p>A after timeout</p>
                    <small>force reveal secret B</small>
                  </div>
                </div>
              </div>
            </div>

            <div class="tx-separator">↓</div>

            <div class="tx cashout-tx">
              <div class="tx-header">
                <h4>Cashout Transaction</h4>
              </div>
              <div class="tx-body">
                <div class="inputs">
                  <div class="input">
                    <h5>Input</h5>
                    <p>Final transaction output</p>
                    <small>Signed by winner</small>
                  </div>
                </div>
                <div class="arrow">→</div>
                <div class="outputs split">
                  <div class="output">
                    <h5>Output</h5>
                    <p>Winner's address</p>
                    <small>Both player's funds</small>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.how-it-works {
  max-width: 1200px;
  margin: 0 auto;
  padding: 2rem 1rem;

  .content {
    background: var(--card);
    border-radius: 1rem;
    padding: 2rem;
    box-shadow: 0 1px 3px 0 rgb(0 0 0 / 0.1);

    h1 {
      text-align: center;
      margin-bottom: 2rem;
      color: var(--primary);
    }

    section {
      margin-bottom: 3rem;

      &:last-child {
        margin-bottom: 0;
      }

      h2 {
        margin-bottom: 1.5rem;
        padding-bottom: 0.5rem;
        border-bottom: 2px solid var(--border);
      }

      p {
        color: var(--text-light);
        line-height: 1.6;
      }

      .features {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
        gap: 2rem;
        margin-top: 1.5rem;

        .feature {
          text-align: center;
          padding: 1.5rem;
          background: var(--background);
          border-radius: 0.5rem;
          
          .material-icons {
            font-size: 2.5rem;
            color: var(--primary);
            margin-bottom: 1rem;
          }

          h3 {
            margin-bottom: 0.75rem;
            font-size: 1.25rem;
          }

          p {
            font-size: 0.95rem;
          }
        }
      }

      ul {
        list-style: disc;
        padding-left: 1.5rem;
        color: var(--text-light);
        
        li {
          margin-bottom: 0.75rem;
          line-height: 1.6;

          &:last-child {
            margin-bottom: 0;
          }
        }
      }
    }
  }
}

.game-flow {
  margin-top: 2rem;
  
  h3 {
    margin-bottom: 1.5rem;
    font-size: 1.2rem;
  }

  .flow-diagram {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    padding: 1.5rem;
    background: var(--background);
    border-radius: 0.5rem;

    .tx {
      background: var(--card);
      border-radius: 0.5rem;
      overflow: hidden;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);

      .tx-header {
        background: var(--primary);
        padding: 0.75rem;
        
        h4 {
          color: white;
          font-size: 1.1rem;
          text-align: center;
        }
      }

      .tx-body {
        padding: 1rem;
        display: flex;
        align-items: center;
        gap: 1rem;

        .inputs, .outputs {
          flex: 1;
          
          h5 {
            color: var(--primary);
            margin-bottom: 0.5rem;
            font-size: 0.9rem;
            text-transform: uppercase;
            letter-spacing: 0.05em;
          }

          h4 {
            color: var(--text);
            font-size: 0.85rem;
            margin-top: 0.75rem;
            margin-bottom: 0.25rem;
            font-weight: 600;
            padding-left: 0.5rem;
            border-left: 2px solid var(--primary);
          }

          p {
            font-size: 1rem;
            color: var(--text);
            margin-bottom: 0.25rem;
            padding-left: 0.5rem;
          }

          small {
            color: var(--text-light);
            font-size: 0.8rem;
            display: block;
            margin-top: 0.5rem;
          }
        }

        .outputs.split {
          display: flex;
          flex-direction: column;
          gap: 1rem;

          .output {
            padding: 0.75rem;
            border-radius: 0.25rem;

            &.win {
              background: rgba(0, 255, 0, 0.1);
            }

            &.lose {
              background: rgba(255, 0, 0, 0.1);
            }
          }
        }

        .arrow {
          color: var(--primary);
          font-size: 1.5rem;
          font-weight: bold;
        }
      }
    }

    .tx-separator {
      color: var(--primary);
      font-size: 1.5rem;
      font-weight: bold;
      text-align: center;
    }
  }
}

@media (max-width: 768px) {
  .flow-diagram {
    .tx {
      .tx-body {
        flex-direction: column;
        text-align: center;

        .arrow {
          transform: rotate(90deg);
        }
      }
    }
  }
}
</style> 