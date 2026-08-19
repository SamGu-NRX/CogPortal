---
jupyter:
  jupytext:
    notebook_metadata_filter: nbsphinx,-kernelspec
    text_representation:
      extension: .md
      format_name: markdown
      format_version: '1.3'
      jupytext_version: 1.13.6
  nbsphinx:
    execute: never
---

# Manually Training a Simple RNN for the Even Odd Problem

```python
import numpy as np

import matplotlib.pyplot as plt
%matplotlib notebook
```

Recall how a straightforward dense neural network struggled to learn the even-odd problem in previous notebook:

>Given an input vector of zeros and ones, predict `1` if the number of ones in the vector is even, and predict `0` if the number of ones in the vector is odd.

In this notebook, we'll show how a very simple RNN (with a hidden state of size 2) can solve the problem.

We'll use the "simple" (aka "vanilla") RNN equation:

\begin{equation}
h_t = f_h(x_t W_{xh} + h_{t-1} W_{hh} + b_h) \\
y_t = f_y(h_t W_{hy} + b_y)
\end{equation}

where $h_t$ is the hidden (or recurrent) state of the cell and $x_t$ is the sequence-element at step-$t$, for $t=0, 1, \dots, T-1$ (with $T$ as the length of our sequence). $y_{T-1}$ is the final output. The $W$ and $b$ parameters are the *learnable parameters of our model*. Specifically: 

- $x_t$ is a descriptor-vector for entry-$t$ in our sequence of data. It has a shape-$(1, C)$.
- $h_t$ is a "hidden-descriptor", which encodes information about $x_t$ *and* information about the preceding entries in our sequence of data, via $h_{t-1}$. It has a shape-$(1, D)$, where $D$ is the dimensionality that we choose for our hidden descriptors (akin to layer size).
- $W_{xh}$ and $b_h$ hold dense-layer weights and biases, respectively, which are used to process our data $x_t$ in order to form $h_t$. Thus $W_{xh}$ has shape $(C, D)$ and $b_h$ has shape-$(1,D)$. 
- $W_{hh}$ hold dense-layer weights, which are used to process our previous hidden-descriptor $h_{t-1}$ in order to form $h_t$. Thus $W_{hh}$ has shape $(D, D)$.
- $W_{hy}$ and $b_y$ hold dense-layer weights and biases, respectively, which are used to process our final hidden-descriptor $h_T$ in order to produce our classification scores, $y_T$. Thus $W_{hy}$ has shape $(D, K)$ and $b_h$ has shape-$(1,K)$. Where $K$ is our number of classes. See that, given our input sequence $x$, we are ultimately producing $y_{T-1}$ of shape-$(1, K)$.

These equations thus say that new hidden state ($h_t$) combines current input ($x_t$) and previous hidden state ($h_{t-1}$), then applies an activation function ($f_h$, e.g., $\tanh$ or $\text{ReLU}$). The output ($y_t$) is then a function of the new hidden state (not necessarily applying the same activation function).

Note: You may see some variations in how simple RNN cells are formulated. Some don't apply an activation function to the output. Some first compute output as a function of the current state and input, and then update the current state to be this output. But the key similarity is that output is ultimately a function of input and a hidden state which is dependant on previous inputs.

It turns out we can solve the even-odd problem with a hidden state of dimension 2.

On top of that, we can figure out what the weights should be by hand, without having to use MyGrad!


## Desired Behavior of the RNN

Let the output $y_t$ of the RNN cell at sequence-step $t$ be 1 if there have been an even number of ones in the sequence so far and 0 if there have been an "odd" number of ones seen so far. Then the following logic is what we want to reproduce:

| $y_{t-1}$ | $x_t$ | $y_{t}$ | meaning |
|:---------:|:-----:|:-------:|:------- |
| 1         | 1     | 0       | even so far, see 1, now odd |
| 1         | 0     | 1       | even so far, see 0, stay even |
| 0         | 1     | 1       | odd so far, see 1, now even |
| 0         | 0     | 0       | odd so far, see 0, stay odd |

This should look familiar: it's exactly the XOR problem! If you aren't familiar with the XOR problem, know that it is simply a type of boolean operation, much like AND or OR. XOR will only return True (or alternatively 1) if both inputs have *different* boolean values. 

The XOR problem cannot be solved by a neural network that has no hidden layers. Instead, the network needs intermediate "helpers" (nodes in a hidden layer) that compute OR and NAND (which can then be combined into the final XOR).

So we can't just have a single hidden value representing even/odd with output $y$ just spitting out the hidden state. This would run into the same problem as XOR. For this problem we'll need a hidden state of size $D=2$. Let $h_t$, the hidden state at time $t$, have the following interpretation:

\begin{equation}
h_t = \begin{bmatrix}h^\text{OR}_t & h^\text{NAND}_t\end{bmatrix}
\end{equation}

where
* $h^\text{OR}_t$ will mean that the previous output $y_{t-1}$ was 1 ("even") **OR** the current input $x_t$ is 1, or both
* $h^\text{NAND}_t$ will mean it's **NOT** the case that previous output $y_{t-1}$ was 1 ("even") **AND** the current input $x_t$ is 1 

So the hidden variables and output at time $t$ are related to certain values from time $t-1$: 

> $h^\text{OR}_{t}$ is a function of $y_{t-1}$ and $x_t$

> $h^\text{NAND}_{t}$ is a function of $y_{t-1}$ and $x_t$

> $y_{t}$ is a function of $h^\text{OR}_{t}$ and $h^\text{NAND}_{t}$

However, based on how the RNN equations are set up, the RNN cell will only have access to the previous hidden state and the current input at each step (not the actual last output). So the RNN will use $h^\text{OR}_{t-1}$ and $h^\text{NAND}_{t-1}$ (which will be sufficient):

> $h^\text{OR}_{t}$ is function of $h^\text{OR}_{t-1}$, $h^\text{NAND}_{t-1}$, and $x_t$

> $h^\text{NAND}_{t}$ is function of $h^\text{OR}_{t-1}$, $h^\text{NAND}_{t-1}$, and $x_t$

> $y_{t}$ is function of $h^\text{OR}_{t}$ and $h^\text{NAND}_{t}$




With this setup, we can now make a table showing the complete desired dynamics of the RNN for solving the even/odd problem. That is, given values of the previous hidden state and current input, we want the RNN to produce particular values for new hidden state and output:

| $h^\text{OR}_{t-1}$ | $h^\text{NAND}_{t-1}$ | $y_{t-1}$ | $x_t$ | $h^\text{OR}_{t}$ | $h^\text{NAND}_{t}$ | $y_{t}$ |
|:-------------------:|:---------------------:|:---------:|:-----:|:-----------------:|:-------------------:|:-------:|
| 1                   | 1                     | 1         | 1     | 1                 | 0                   | 0       |
| 1                   | 1                     | 1         | 0     | 1                 | 1                   | 1       |
| 1                   | 0                     | 0         | 1     | 1                 | 1                   | 1       |
| 1                   | 0                     | 0         | 0     | 0                 | 1                   | 0       |
| 0                   | 1                     | 0         | 1     | 1                 | 1                   | 1       |
| 0                   | 1                     | 0         | 0     | 0                 | 1                   | 0       |


<!-- #region -->
## Finding Weights and Biases

Recall the simple RNN equations:

\begin{equation}
h_t = f_h(x_t W_{xh} + h_{t-1} W_{hh} + b_h) \\
y_t = f_y(h_t W_{hy} + b_y)
\end{equation}

For simplicity, we'll use the "hard sigmoid" for the activation functions, which maps positive inputs to 1 and non-positive inputs to 0:

```python
f(x) = (np.sign(x) + 1) / 2
```

That way we can just focus on finding weights that make the arguments to the hardsigmoid activations:

\begin{equation}
x_t W_{xh} + h_{t-1} W_{hh} + b_h
\end{equation}

and

\begin{equation}
h_t W_{hy} + b_y
\end{equation}

positive or negative as needed.
<!-- #endregion -->

Define the `hardsigmoid` activation function and plot it on [-2, 2] using 1000 points.

```python
# <COGINST>
def hardsigmoid(x):
    return (np.sign(x) + 1) / 2

x = np.linspace(-2, 2, 1000)
fig, ax = plt.subplots()
ax.plot(x, hardsigmoid(x))
ax.grid();
# </COGINST>
```

### Finding the weights to produce $h^\text{OR}_t$


Writing out the update equation for $h_t$ more explicitly, we have:

\begin{equation}
\begin{bmatrix}h^\text{OR}_t & h^\text{NAND}_t\end{bmatrix} = \text{hardsigmoid}\left(x_t\begin{bmatrix}W_{xh}^{(0,0)} & W_{xh}^{(0,1)}\end{bmatrix} + \begin{bmatrix}h^\text{OR}_{t-1} & h^\text{NAND}_{t-1}\end{bmatrix}\begin{bmatrix}W_{hh}^{(0,0)} & W_{hh}^{(0,1)} \\ W_{hh}^{(1,0)} & W_{hh}^{(1,1)} \end{bmatrix} +
\begin{bmatrix}b^\text{OR} & b^\text{NAND}\end{bmatrix}\right)
\end{equation}

Looking at just $h^\text{OR}_t$ for now, we have

\begin{equation}
h^\text{OR}_t = \text{hardsigmoid}\left(x_t W_{xh}^{(0,0)} +  h^\text{OR}_{t-1}\cdot W_{hh}^{(0,0)}  + h^\text{NAND}_{t-1}\cdot W_{hh}^{(1,0)}  + b^\text{OR}\right)
\end{equation}

Incorporating actual values from the table and focusing on the sign of the input to $f$ (hard-sigmoid), we ultimately arrive at a system of six constraints: 

\begin{equation}
\begin{bmatrix}
1 & 1 & 1 \\
0 & 1 & 1 \\
1 & 1 & 0 \\
0 & 1 & 0 \\
1 & 0 & 1 \\
0 & 0 & 1 \\
\end{bmatrix}
\begin{bmatrix}
W_{xh}^{(0,0)} \\
W_{hh}^{(0,0)} \\
W_{hh}^{(1,0)} \\
\end{bmatrix}
+ b^\text{OR}
\longrightarrow
\begin{bmatrix}
+ \\
+ \\
+ \\
- \\
+ \\
- \\
\end{bmatrix}
\end{equation}

where the 3 columns correspond to $x_t$, $h^\text{OR}_{t-1}$, and $h^\text{NAND}_{t-1}$ and the plusses and minuses on the right correspond to $h^\text{OR}_t$.

Now find (by hand!) a set of weights that satisfy these constraints!

```python
# here's the matrix from the equation above, 
# you can use for experimenting and testing
A = np.array([[1, 1, 1],
              [0, 1, 1],
              [1, 1, 0],
              [0, 1, 0],
              [1, 0, 1],
              [0, 0, 1]])

# <COGINST>
w = np.array([1, 1, 1]).T
b = -1.5
hardsigmoid(A @ w + b)
# </COGINST>
```

Test your weights. You should get, after passing your vector through the hard-sigmoid activation, `array([ 1.,  1.,  1.,  0.,  1.,  0.])` which matches table column for $h^{OR}_{t}$.


### Finding the weights to produce $h^\text{NAND}_t$

Let's repeat the process for $h^\text{NAND}_t$:

\begin{equation}
h^\text{NAND}_t = \text{hardsigmoid}\left(x_t W_{xh}^{(0,1)} +  h^\text{OR}_{t-1}\cdot W_{hh}^{(0,1)}  + h^\text{NAND}_{t-1}\cdot W_{hh}^{(1,1)}  + b^\text{NAND}\right)
\end{equation}

We can derive the following constraints for $h^\text{NAND}$ from the table:
\begin{equation}
\begin{bmatrix}
1 & 1 & 1 \\
0 & 1 & 1 \\
1 & 1 & 0 \\
0 & 1 & 0 \\
1 & 0 & 1 \\
0 & 0 & 1 \\
\end{bmatrix}
\begin{bmatrix}
W_{xh}^{(0,1)} \\
W_{hh}^{(0,1)} \\
W_{hh}^{(1,1)} \\
\end{bmatrix}
+ b^\text{NAND}
\longrightarrow
\begin{bmatrix}
- \\
+ \\
+ \\
+ \\
+ \\
+ \\
\end{bmatrix}
\end{equation}

Again, find the parameters that satisfy these constraints.

```python
# <COGINST>
w = np.array([-1, -1, -1]).T
b = 2.5
hardsigmoid(np.dot(A, w) + b)
# </COGINST>
```

Test your weights. You should get `[ 0.,  1.,  1.,  1.,  1.,  1.]` which matches table column for $h^{NAND}_{t}$.


### Weights for $y_t$

Finally, let's finish up with $y_t$:

\begin{equation}
y_t = \text{hardsigmoid}\left(\begin{bmatrix}h^{OR}_t & h^{NAND}_t\end{bmatrix}
\begin{bmatrix}W_{hy}^{(0,0)} \\ W_{hy}^{(1,0)}\end{bmatrix}+ b_y\right)
\end{equation}

Deriving constraints from the table, we get:

\begin{equation}
\begin{bmatrix}
1 & 0 \\
1 & 1 \\
1 & 1 \\
0 & 1 \\
1 & 1 \\
0 & 1 \\
\end{bmatrix}
\begin{bmatrix}
W_{hy}^{(0,0)} \\
W_{hy}^{(1,0)}
\end{bmatrix}
+ b_y
\longrightarrow
\begin{bmatrix}
- \\
+ \\
+ \\
- \\
+ \\
- \\
\end{bmatrix}
\end{equation}

Find values for the unknowns to make this constraints work.

```python
# here's a new A matrix for experimenting
A = np.array([[1, 0],
              [1, 1],
              [1, 1],
              [0, 1],
              [1, 1],
              [0, 1]])

# <COGINST>
w = np.array([1, 1]).T
b = -1.5
hardsigmoid(np.dot(A, w) + b)
# </COGINST>
```

Test your weights. You should get `[ 0.,  1.,  1.,  0.,  1.,  0.]`, which matches table column for $y_{t}$.

<!-- #region -->
### Putting the Weights Together

Based on what you've worked out, assemble all the necessary weights: `W_xh, W_hh, b_h, W_hy, b_y`

The shapes should be:
```python
>>> print(W_xh.shape, W_hh.shape, b_h.shape, W_hy.shape, b_y.shape)
(1, 2) (2, 2) (1, 2) (2, 1) (1, 1)
```

There are 11 total parameters in these matrices.
<!-- #endregion -->

```python
# <COGINST>
W_xh = np.array([1, -1]).reshape(1, 2)

W_hh = np.array([1, 1, -1, -1]).reshape(2, 2).T

b_h = np.array([-1.5, 2.5]).reshape(1, 2)

W_hy = np.array([1, 1]).reshape(2, 1)

b_y = np.array([-1.5]).reshape(1, 1)

print(W_xh.shape, W_hh.shape, b_h.shape, W_hy.shape, b_y.shape)
# </COGINST>
```

## Testing our RNN

Now let's actually apply our RNN. Complete the step function, which takes one time step in our RNN according to the equations:

\begin{equation}
h_t = \text{hardsigmoid}(x_t W_{xh} + h_{t-1} W_{hh} + b_h) \\
y_t = \text{hardsigmoid}(h_t W_{hy} + b_y)
\end{equation}

```python
def step(W_xh, W_hh, b_h, W_hy, b_y, h, x):
    """
    Applies forward pass of simple RNN according to equations:
        h_t = hardsigmoid(x_t W_{xh} + h_{t-1} W_{hh} + b_h)
        y_t = hardsigmoid(h_t W_{hy} + b_y)
    
    Parameters
    ----------
    W_xh: ndarray, shape=(1, 2)
        The weights used in computing h_t from the current value in the sequence
    
    W_hh: ndarray, shape=(2, 2)
        The weights used in computing h_t from the previous hidden state
    
    b_h: ndarray, shape=(1, 2)
        The bias used for computing the current hidden state
    
    W_hy: ndarray, shape=(2, 1)
        The weights used for computing y_t from h_t
    
    b_y: ndarray, shape=(1, 1)
        The bias for computing the y term
    
    h: ndarray, shape=(1, 2)
        The hidden state of the previous time step
    
    x: int
        The current value (1 or 0) in the even-odd sequence
    
    Returns
    -------
    h_t: ndarray, shape=(1, 2)
        The hidden state of the current time step
    
    y_t: ndarray, shape=(1, 1)
        An integer tracking whether the sequence is even (y=1) or odd (y=0)
    """
    # <COGINST>
    h = hardsigmoid(np.dot(x, W_xh) + np.dot(h, W_hh) + b_h)
    y = hardsigmoid(np.dot(h, W_hy) + b_y)
    return y, h
    # </COGINST>
```

Initialize hidden state to "even".

```python
h = np.array([1., 1.]).reshape(1, 2) # </COGLINE>
```

Call step with initial hidden state and input x = 0. Verify that output is still "even" (y = 1).

```python
# <COGINST>
y, h = step(W_xh, W_hh, b_h, W_hy, b_y, h, 0)
y
# </COGINST>
```

Call step with previous hidden state and input x = 1. Verify that output is now "odd" (y = 0).

```python
# <COGINST>
y, h = step(W_xh, W_hh, b_h, W_hy, b_y, h, 1)
y
# </COGINST>
```

Call step with previous hidden state and input x = 1. Verify that output is "even" again (y = 1).

```python
# <COGINST>
y, h = step(W_xh, W_hh, b_h, W_hy, b_y, h, 1)
y
# </COGINST>
```

Now evaluate on sequences of 0s and 1s of various sizes and display the output values. You will want to iteratively call your `step ` function and save the resullting `y` values.

```python
# <COGINST>
xs = [0, 1, 1, 0, 1, 1]

# initialize hidden state to "even"
h = np.array([1, 1]).reshape(1, 2)

# save ys
ys = []
for x in xs:
    y, h = step(W_xh, W_hh, b_h, W_hy, b_y, h, x)
    ys.append(y.item())
    
ys
# </COGINST>
```

You were able to create a simple recurrent neural network (with just 11 parameters) that could do a task that a much more complex network (with many more parameters) failed to do!

What mechanism allowed this? Do you think this simple version is flexible enough for harder problems? Discuss with a partner!
