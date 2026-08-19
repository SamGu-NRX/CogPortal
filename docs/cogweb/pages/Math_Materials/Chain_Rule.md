---
jupyter:
  jupytext:
    text_representation:
      extension: .md
      format_name: markdown
      format_version: '1.3'
      jupytext_version: 1.13.6
  kernelspec:
    display_name: Python [conda env:.conda-mygrad]
    language: python
    name: conda-env-.conda-mygrad-py
---

<!-- #raw raw_mimetype="text/restructuredtext" -->
.. meta::
   :description: Topic: Math supplement, Difficulty: Medium, Category: Section
   :keywords: chain rule, derivative, calculus
<!-- #endraw -->

# Chain Rule


In the machine learning world, we will often deal with functions that are more complex than simple polynomial, exponential, or sinusoidal functions. 
Most of the time, [functions will be composite](https://rsokl.github.io/CogWeb/Math_Materials/Functions.html#Function-Composition), meaning that one function will be located inside another function (which might also be located within another function).
The functions $\sin{(x^2)}$, $\ln{(4x\cos{(x^3)}+x)}$, and $e^{\cos{(3x^2 + 4)}}$ are all composite functions, and being able to calculate the derivatives of such functions is essential for training neural networks.

This material introduces a simple method for computing derivatives of composite functions: the so-called chain rule.


## Basics of the Chain Rule

The chain rule can become unruly from a notational point of view when using the Leibniz notation for the derivative: $\frac{\mathrm{d}f}{\mathrm{d}x}$. 
For the moment, let's adopt a functional notation for the derivative: $f'(x)$.
That is, $\frac{\mathrm{d}f}{\mathrm{d}x}$ and $f'(x)$ represent exactly the same function - the derivative of $f(x)$. 
Additionally, let's assume that all of our functions are only single-variable functions, for the time being.

Given the composition of the function $g(x)$ with the function $f(x)$

\begin{equation}
(g \circ f)(x),
\end{equation}

the **chain rule** states that the derivative of the composite function with respect to $x$ is given by the composition of the function $g'(x)$ with $f(x)$, multiplied by $f'(x)$:

\begin{equation}
(g \circ f)'(x) = g'(f(x)) \cdot f'(x).
\end{equation}

Using the $g \circ f$ notation for function composition, the chain rule says

\begin{equation}
(g \circ f)'(x) = (g' \circ f)(x) \cdot f'(x).
\end{equation}


### Example Calculation Using the Chain Rule
Let's jump to an example immediately to make sure that we are not confused by this notation. Consider the following functions:

\begin{align}
f(x) &= 3x + 1\\
g(x) &= x^2 - 2\\
(g \circ f)(x) &= (3x + 1)^2 - 2
\end{align}

The derivatives of $f(x)$ and $g(x)$ are quite simple:
\begin{align}
f'(x) &= 3\\
g'(x) &= 2x\\
\end{align}

According to the chain rule, this is all we need to compute the derivative of $(g\circ f)(x)$. Recognizing that $(g'\circ f)(x) = 2f(x)$, we can write the derivative of $(g\circ f)(x)$ as

\begin{equation}
(g \circ f)'(x) = (g'\circ f)(x) \cdot f'(x) = 2f(x) \cdot  f'(x).
\end{equation}

Plugging in for $f(x)$ and $f'(x)$, we obtain

\begin{equation}
(g \circ f)'(x) = 2(3x + 1) \cdot 3 = 18x + 6.
\end{equation}

As an exercise, write $(g \circ f)(x)$ out in full — as $(g \circ f)(x) = (3x + 1)^2 - 2$, expanding the squared term — and take its derivative directly. 
Verify that the result you obtain agrees with the equation for $(g \circ f)'(x)$ that we arrived at by using the chain rule. 
Review this example carefully, and be sure to have a clear understanding of the symbolic form of the chain rule.


## Representing the Chain Rule Using Leibniz Notation

We will ultimately need to make use of the chain rule generalized to *multivariable* functions. 
For this, Leibniz notation is extremely valuable. 
[Recall](https://rsokl.github.io/CogWeb/Math_Materials/Multivariable_Calculus.html#What-is-a-Partial-Derivative?) that we write the partial derivative of $f(x,y)$ with respect to $x$ as $\frac{\partial f}{\partial x}$. 
Let's translate the chain rule into Leibniz notation:

\begin{align}
(g \circ f)'(x) &\longrightarrow \frac{\mathrm{d}(g \circ f)}{\mathrm{d}x} \\ 
g'(f(x)) &\longrightarrow \frac{\mathrm{d}g}{\mathrm{d}f}\Bigr|_{f=f(x)} \\
f'(x) &\longrightarrow \frac{\mathrm{d}f}{\mathrm{d}x} \\
(g \circ f)'(x) = (g'\circ f)(x) \cdot f'(x) &\longrightarrow \frac{\mathrm{d}((g \circ f)(x))}{\mathrm{d}x} = \frac{\mathrm{d}g}{\mathrm{d}f}\Bigr|_{f=f(x)}\frac{\mathrm{d}f}{\mathrm{d}x}
\end{align}

Here, $g(x)$ depends on another dependent variable: $f(x)$.
This is why we use the vertical line to indicate that the derivative of $g(x)$ is to be evaluated using the value of $f(x)$ as its input variable.
Because we will always evaluate intermediate derivatives within the chain rule in this fashion, we can forego using the vertical line and simply remain mindful of the preceding statement.
Thus the chain rule, written using Leibniz notation, is

\begin{equation}
\frac{\mathrm{d}((g \circ f)(x))}{\mathrm{d}x} = \frac{\mathrm{d}g}{\mathrm{d}f}\frac{\mathrm{d}f}{\mathrm{d}x}.
\end{equation}

This is the notation that we will use moving forward, especially as we begin to work with partial derivatives of multivariable functions. 
This simple chain rule is also sufficient for generalizing to an arbitratily-long sequence of compositions. 


<div class="alert alert-info">

**Reading Comprehension: Proof of Chain Rule With Multiple Composite Functions**
    
Use the equation $\frac{\mathrm{d}(g \circ f)}{\mathrm{d}x} = \frac{\mathrm{d}g}{\mathrm{d}f}\frac{\mathrm{d}f}{\mathrm{d}x}$ to prove that

\begin{equation}
\frac{\mathrm{d} (f_1 \circ f_2 \circ \cdots \circ f_n)}{\mathrm{d}x} = \frac{\mathrm{d}f_1}{\mathrm{d}f_2}\frac{\mathrm{d}f_2}{\mathrm{d}f_3} \cdots \frac{\mathrm{d}f_{n-1}}{\mathrm{d}f_n}\frac{\mathrm{d}f_n}{\mathrm{d}x},
\end{equation}
    
where $\frac{\mathrm{d}f_j}{\mathrm{d}f_{j+1}}$ is understood to be evaluated at $(f_{j+1} \circ \cdots \circ f_n)(x)$.
    
Hint: Consider one composition at a time.
In other words, what is $\frac{\mathrm{d}(f_1\circ g)}{\mathrm{d}x}$, where $g=f_2\circ\cdots\circ f_n$?

</div>


One final note to help clarify the vertical-bar notation used above. 
If we wanted to compute the derivative of $(g \circ f)$, evaluated at, say, $x = 2$, we would denote this as

\begin{equation}
\frac{\mathrm{d}(g \circ f)}{\mathrm{d}x}\bigg|_{x=2} = \frac{\mathrm{d}g}{\mathrm{d}f}\bigg|_{f=f(2)} \frac{\mathrm{d}f}{\mathrm{d}x} \bigg|_{x=2},
\end{equation}

which, of course, is the same as writing

\begin{equation}
(g \circ f)'(2) = g'(f(2)) \cdot f'(2).
\end{equation}

To be clear, $(g \circ f)'(2)$ and $\frac{\mathrm{d}(g \circ f)}{\mathrm{d}x}\Bigr|_{x=2}$ both mean: take the derivative of $(g \circ f)(x)$ and evaluate the resulting function at $x = 2$. It doesn't make sense to take the derivative of $(g \circ f)(2)$, as this is simply a number.


<div class="alert alert-info">

**Reading Comprehension: Chain Rule With a Single Variable Function**

Calculate the derivative with respect to $x$ of the function

\begin{equation}
f(x) = (3x+1)^3 + 8\cdot(3x+1) + 6.
\end{equation}
    
First, do this using the chain rule. 
Then do it by expanding out the function and using just the power rule.
Confirm that both derivatives are equivalent.

</div>


## The Chain Rule for Multivariable Functions
The case of composing a single-variable function with a multivariable one is quite simple for extending the chain rule with partial derivatives. Take the single-variable function $g(x)$ and multivariable function $f(x,y)$. Then, for $g(f(x,y))$,
\begin{align}
\frac{\mathrm{d}g}{\mathrm{d}x} &= \frac{\mathrm{d}g}{\mathrm{d}f}\frac{\partial f}{\partial x} \\
\frac{\mathrm{d}g}{\mathrm{d}y} &= \frac{\mathrm{d}g}{\mathrm{d}f}\frac{\partial f}{\partial y}
\end{align}

The partial derivative of $g(x)$ with respect to $x$ ($y$) is given by the derivative of $g(x)$, evaluated at $f(x, y)$, times the partial derivative of $f(x,y)$ with respect to $x$ ($y$).  
Qualitatively, $\frac{\partial f}{\partial x}$ represents the change in $f(x,y)$ that occurs given a small change in $x$ (holding $y$ fixed);
$\frac{\mathrm{d}g}{\mathrm{d}f}$ represents the change in $g(x)$ given a small change in the value of $f(x,y)$. 
It follows, then, that $\frac{\mathrm{d}g}{\mathrm{d}f}\frac{\partial f}{\partial x}$ represents the change in $g(f(x, y))$ given a small change in $x$ *only*. 
This is exactly what $\frac{\partial g}{\partial x}$ represents.

You will also encounter more complicated instances, in which $g$ itself depends on multiple functions of the independent variables: $g(x, y) = g(p(x, y),\, q(x, y))$. 
*The following result is very important*.
Here, you simply **accumulate** (i.e. sum) the derivatives that are contributed by $p$ and $q$, respectively:

\begin{align}
\frac{\mathrm{d} g}{\mathrm{d} x} &= \frac{\partial g}{\partial p}\frac{\partial p}{\partial x} + \frac{\partial g}{\partial q}\frac{\partial q}{\partial x} \\
\frac{\mathrm{d} g}{\mathrm{d} y} &= \frac{\partial g}{\partial p}\frac{\partial p}{\partial y} + \frac{\partial g}{\partial q}\frac{\partial q}{\partial y} \\
\end{align}

Again, this can be generalized to accommodate an arbitrary number of dependent variables. So, for the function $g(f_1(x, y), f_2(x, y), ..., f_n(x, y))$,
\begin{align}
\frac{\mathrm{d} g}{\mathrm{d} x} &= \frac{\partial g}{\partial f_1}\frac{\partial f_1}{\partial x} + \frac{\partial g}{\partial f_2}\frac{\partial f_2}{\partial x} + ... + \frac{\partial g}{\partial f_n}\frac{\partial f_n}{\partial x} \\
\frac{\mathrm{d} g}{\mathrm{d} y} &= \frac{\partial g}{\partial f_1}\frac{\partial f_1}{\partial y} + \frac{\partial g}{\partial f_2}\frac{\partial f_2}{\partial y} + ... + \frac{\partial g}{\partial f_n}\frac{\partial f_n}{\partial y} \\
\end{align}

This should make sense once dissected — we want to describe how varying $x$ by a small amount affects $g$. 
Thus we need to know how varying $x$ affects $f_1$ $\big(\!$ through $\frac{\partial f_1}{\partial x}\big)$, and multiply it with how varying $f_1$ affects $g$ $\big(\!$ through $\frac{\partial g}{\partial f_1}\big)$.
So $\frac{\partial g}{\partial f_1}\frac{\partial f_1}{\partial x}$ describes how varying $x$ affects $g$ **via** $f_1$. 
Repeat this for $f_2,\dots,\,f_n$, and sum up all of these contributions to arrive at how varying $x$ affects $g$ in total: $\frac{\mathrm{d} g}{\mathrm{d} x}$


### A Simple Example 

Given the following functions, we will calculate $\frac{\mathrm{d} g}{\mathrm{d} x}$ and $\frac{\mathrm{d} g}{\mathrm{d} y}$ at the point $(x=3, y=1)$. Take $g(p(x,y), q(x, y))$ to be given by

\begin{align}
g(p, q) &= p^2 - q^3 \\
p(x, y) &= yx^2 \\
q(x, y) &= 2x + y \\
\end{align}

According to the chain rule provided above, the derivatives needed to compute $\frac{\mathrm{d} g}{\mathrm{d} x}$ and $\frac{\mathrm{d} g}{\mathrm{d} y}$ are simply
\begin{align}
\frac{\partial g}{\partial p}\bigg|_{x=3, y=1} &= 2p(3, 1) = 2\cdot (1 \cdot 3^2) = 18\\
\frac{\partial g}{\partial q}\bigg|_{x=3, y=1} &= -3q(3, 1)^2 = -3\cdot (2 \cdot 3 + 1)^2 = -3\cdot (49) = -147 \\
\frac{\partial p}{\partial x}\bigg|_{x=3, y=1} &= 2yx\big|_{x=3, y=1} = 2 (1 \cdot 3) = 6\\ 
\frac{\partial p}{\partial y}\bigg|_{x=3, y=1} &= x^2\big|_{x=3, y=1} = 3^2 = 9\\
\frac{\partial q}{\partial x}\bigg|_{x=3, y=1} &= 2 \\ 
\frac{\partial q}{\partial y}\bigg|_{x=3, y=1} &= 1
\end{align}

We can simply plug these values into the expression for the chain rule for a function of multiple dependent variables, and we will have computed the derivatives of $g$ with respect to $x$ and $y$ at the given point:

\begin{align}
\frac{\mathrm{d} g}{\mathrm{d} x} &= \frac{\partial g}{\partial p}\frac{\partial p}{\partial x} + \frac{\partial g}{\partial q}\frac{\partial q}{\partial x} \longrightarrow \frac{\mathrm{d} g}{\mathrm{d} x}\bigg|_{x=3, y=1} = 18\cdot 6 + (-147)\cdot 2 = -186 \\
\frac{\mathrm{d} g}{\mathrm{d} y} &= \frac{\partial g}{\partial p}\frac{\partial p}{\partial y} + \frac{\partial g}{\partial q}\frac{\partial q}{\partial y} \longrightarrow \frac{\mathrm{d} g}{\mathrm{d} y}\bigg|_{x=3, y=1} = 18\cdot 9 + (-147) \cdot 1 = 15
\end{align}


## Autodifferentiation and the Chain Rule

<!-- #region -->
Autodifferentiation libraries, like MyGrad, naturally use the chain rule to compute derivatives of composite functions.
See that it reproduces the exact same values for derivatives as indicated above.

```python
# Using MyGrad to evaluate the partial derivatives
# of a composite multivariable function

import mygrad as mg

# Initializes x and y as tensors
>>> x = mg.tensor(3)
>>> y = mg.tensor(1)
>>> p = y * x ** 2
>>> q = 2 * x + y

>>> g = p ** 2 - q ** 3

# Computes the derivatives of g with respect to all
# variables that it depends on
>>> g.backward()

>>> p.grad  # stores ∂g/∂p @ x=3, y=1
array(18.)
>>> q.grad  # stores ∂g/∂q @ x=3, y=1
array(-147.)
>>> x.grad  # stores dg/dx @ x=3, y=1
array(-186.)
>>> y.grad  # stores dg/dy @ x=3, y=1
array(15.)
```
<!-- #endregion -->

<div class="alert alert-info">

**Reading Comprehension: Chain Rule With a Multivariable Function**

For $g(p(x,y), q(x,y))$, where   
    
\begin{align}
g(p, q) &= p^2\cdot q, \\
p(x, y) &= 4y - x, \\
q(x, y) &= 3xy - 4y,
\end{align}

calculate $\frac{\mathrm{d} f}{\mathrm{d} y}\big|_{x=5, y=4}$.
</div>


<div class="alert alert-info">

**Reading Comprehension: Chain Rule With a Multivariable Function With MyGrad**

Calculate the same partial derivative from the previous question (**Chain Rule With a Multivariable Function**), but this time, compute it using MyGrad.
Verify that this gives the same result as doing the math by hand.
</div>


## Reading Comprehension Exercise Solutions

<!-- #region -->
**Proof of Chain Rule With Multiple Composite Functions: Solution**

We are given that $\frac{\mathrm{d}(g \circ f)}{\mathrm{d}x} = \frac{\mathrm{d}g}{\mathrm{d}f}\frac{\mathrm{d}f}{\mathrm{d}x}$.

Performing one iteration of the chain rule on the given function, we get that 

\begin{equation}
\frac{\mathrm{d} (f_1 \circ f_2 \circ \cdots \circ f_n)}{\mathrm{d}x} = \frac{\mathrm{d}f_1}{\mathrm{d}f_2}\frac{\mathrm{d}f_2}{\mathrm{d}x}.
\end{equation}

Performing the chain rule on $\frac{\mathrm{d}f_2}{\mathrm{d}x}$, we find that

\begin{equation}
\frac{\mathrm{d}f_2}{\mathrm{d}x} = \frac{\mathrm{d}f_2}{\mathrm{d}f_3}\frac{\mathrm{d}f_3}{\mathrm{d}x}.
\end{equation}

Substituting this into the previous equation, we get that

\begin{equation}
\frac{\mathrm{d} (f_1 \circ f_2 \circ \cdots \circ f_n)}{\mathrm{d}x} = \frac{\mathrm{d}f_1}{\mathrm{d}f_2}\frac{\mathrm{d}f_2}{\mathrm{d}f_3}\frac{\mathrm{d}f_3}{\mathrm{d}x}.
\end{equation}

We can keep repeating this process and we will find that

\begin{equation}
\frac{\mathrm{d} (f_1 \circ f_2 \circ \cdots \circ f_n)}{\mathrm{d}x} = \frac{\mathrm{d}f_1}{\mathrm{d}f_2}\frac{\mathrm{d}f_2}{\mathrm{d}f_3} \cdots \frac{\mathrm{d}f_{n-1}}{\mathrm{d}f_n}\frac{\mathrm{d}f_n}{\mathrm{d}x}.
\end{equation}

---
**Chain Rule With a Single Variable Function: Solution**

The chain rule states that $\frac{\mathrm{d}f}{\mathrm{d}x} = \frac{\mathrm{d}f}{\mathrm{d}u}\frac{\mathrm{d}u}{\mathrm{d}x}$.

The value of $u(x)$ will be 3x+1, and $\frac{\mathrm{d}u}{\mathrm{d}x}$ will be 3.

The value of $f(x)$ will be $(3x+1)^3 + 8\cdot(3x+1) + 6$.

So, $\frac{\mathrm{d}f}{\mathrm{d}u}$ will be the derivative of $f(x)$ with respect to $3x+1$, which will be $3\cdot(3x+1)^2 + 8$.

Putting it all together, we find that

\begin{equation}
\frac{\mathrm{d}f}{\mathrm{d}x} = (3\cdot(3x+1)^2 + 8)\cdot3=81x^2 + 54x + 33.
\end{equation}

By expanding out the function, we get that $f(x) =27x^3 + 27x^2 + 33x + 15$.

Taking the derivative with respect to $x$, we find that $\frac{\mathrm{d}f}{\mathrm{d}x} = 81x^2 + 54x + 33$, which is the same answer that we got using the chain rule.

---
**Chain Rule With a Multivariable Function: Solution**

The multivariable chain rule states that

\begin{equation}
\frac{\mathrm{d} g}{\mathrm{d} y} = \frac{\partial g}{\partial p}\frac{\partial p}{\partial y} +  \frac{\partial g}{\partial q}\frac{\partial q}{\partial y}
\end{equation}

We can now find the partial derivatives of $f$ with respect to $p$ and $q$ and evaluate at $(x,y)=(5,4)$:

\begin{align}
\frac{\partial g}{\partial p}\bigg|_{x=5,y=4} &= 2\cdot p(5, 4) \cdot q(5, 4) = 2\cdot (4*4 - 5)\cdot (3\cdot 5\cdot 4 - 4\cdot 4) = 968\\
\frac{\partial g}{\partial q}\bigg|_{x=5,y=4} &= p(5, 4)^2 = (4\cdot 4 - 5)^2 = 121\\
\end{align}

Finally, the partial derivatives of $p$ and $q$ with respect to $y$ can be found and evaluated as

\begin{align}
\frac{\partial p}{\partial y}\bigg|_{x=5,y=4} &= 4\\
\frac{\partial q}{\partial y}\bigg|_{x=5,y=4} &= 3(5) - 4 = 11\\
\end{align}

Therefore

\begin{equation}
\frac{\mathrm{d} g}{\mathrm{d} y}\bigg|_{x=5,y=4} = 968 \cdot 4 + 121 \cdot 11 = 5203\\
\end{equation}

---
**Chain Rule With a Multivariable Function With MyGrad: Solution**

```python
# Using MyGrad to evaluate the partial derivatives of a multivariable function
import mygrad as mg


# Initializes x and y as tensors
>>> x = mg.tensor(5)
>>> y = mg.tensor(4)
>>> p = 4 * y - x
>>> q = 3 * x * y - 4 * y

>>> g = p ** 2 * q

# Computes the derivatives of g with respect to all
# variables that it depends on
>>> g.backward()

>>> p.grad  # stores ∂g/∂p @ x=5, y=4
array(968.)
>>> q.grad  # stores ∂g/∂q @ x=5, y=4
array(121.)
>>> x.grad  # stores dg/dx @ x=5, y=4
array(484.)
>>> y.grad  # stores dg/dy @ x=5, y=4
array(5203.)
```
<!-- #endregion -->
